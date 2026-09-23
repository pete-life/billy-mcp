import { DatabaseSync } from 'node:sqlite';
import { chmodSync, writeFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export type Plan = {id: string; hash: string; operation: any; snapshots: any[]; reason: string; createdAt: string; status: string; result?: any; executorPid?:number};
export type Receipt = {id: string; path: string; name: string; mime: string; sources: any[]; metadata: any; attachmentId?: string};
export type BatchLease={batchId:string;nonce:string};
export type BatchStage={planId:string;hash:string;status:'prepared'|'completed'};
export type Batch={id:string;hash:string;intent:string;spec:any;snapshots:any[];createdAt:string;status:'prepared'|'running'|'paused'|'completed';stages:Record<string,BatchStage>;approval?:{mode:string;at:string;scopeHash:string};runnerPid?:number;leaseNonce?:string;error?:string};
function processAlive(pid:number) {try{process.kill(pid,0);return true;}catch{return false;}}
export class Store {
  private db: DatabaseSync;
  constructor(public root: string, public inbox: string, public organizationId: string) {
    mkdirSync(root, {recursive: true, mode: 0o700}); chmodSync(root, 0o700);
    mkdirSync(join(root,'receipts'), {recursive: true, mode: 0o700});
    mkdirSync(inbox, {recursive: true, mode: 0o700});
    const dbPath = join(root,'state.sqlite'); this.db = new DatabaseSync(dbPath); chmodSync(dbPath, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, org TEXT NOT NULL, hash TEXT NOT NULL, intent TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(org,intent));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT NOT NULL, org TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(org,id));
      CREATE TABLE IF NOT EXISTS vendors (id TEXT NOT NULL, org TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(org,id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, org TEXT NOT NULL, time TEXT NOT NULL, plan_id TEXT, event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, org TEXT NOT NULL, intent TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(org,intent));
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_batch ON batches(org) WHERE status='running';
      CREATE UNIQUE INDEX IF NOT EXISTS one_executing ON plans(org) WHERE status='executing';`);
  }
  close() {this.db.close();}
  event(planId: string, event: string) {this.db.prepare('INSERT INTO events(org,time,plan_id,event) VALUES(?,?,?,?)').run(this.organizationId, new Date().toISOString(),planId,event);}
  prepare(operation: any, snapshots: any[], reason: string): Plan {
    // Snapshot changes do not turn the same financial operation into a new write.
    const intent = digest({organizationId: this.organizationId, operation});
    const hash = digest({intent, snapshots});
    const existing = this.db.prepare('SELECT data,status FROM plans WHERE org=? AND intent=?').get(this.organizationId, intent) as any;
    if (existing) {
      const old={...JSON.parse(existing.data),status:existing.status} as Plan;
      if(old.status==='prepared'&&digest(old.snapshots)!==digest(snapshots))throw new Error(`Existing plan ${old.id} has stale snapshots; refresh and review it explicitly`);
      return old;
    }
    const plan: Plan = {id: randomUUID(), hash, operation, snapshots, reason, createdAt: new Date().toISOString(), status:'prepared'};
    this.db.prepare('INSERT INTO plans VALUES(?,?,?,?,?,?)').run(plan.id,this.organizationId,hash,intent,plan.status,JSON.stringify(plan));
    this.event(plan.id,'prepared'); return plan;
  }
  plan(planId: string): Plan {
    const row = this.db.prepare('SELECT data,status FROM plans WHERE id=? AND org=?').get(planId,this.organizationId) as any;
    if (!row) throw new Error('Unknown plan'); return {...JSON.parse(row.data),status:row.status};
  }
  claim(planId: string, hash: string,batchLease?:BatchLease): Plan {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active=this.db.prepare("SELECT id,data FROM batches WHERE org=? AND status='running'").get(this.organizationId) as {id:string;data:string}|undefined;
      if(active){
        const batch=JSON.parse(active.data) as Batch;
        if(batch.runnerPid&&!processAlive(batch.runnerPid))this.db.prepare("UPDATE batches SET status='paused',data=? WHERE id=? AND org=? AND status='running'").run(JSON.stringify({...batch,status:'paused',leaseNonce:undefined,runnerPid:undefined,error:'Batch runner exited; inspect child plans before resuming.'}),batch.id,this.organizationId);
        else if(!batchLease||batchLease.batchId!==batch.id||batchLease.nonce!==batch.leaseNonce||batch.runnerPid!==process.pid)throw new Error('A batch owns company writes; resume or wait for it before a separate execution.');
      } else if(batchLease)throw new Error('Batch lease is no longer active.');
      const plan = this.plan(planId);
      if (hash !== plan.hash) throw new Error('Plan hash mismatch');
      if (plan.status !== 'prepared') throw new Error(`Plan is ${plan.status}; never repeat an uncertain or completed write`);
      if (Date.now()-Date.parse(plan.createdAt)>30*60*1000) throw new Error('Plan expired; refresh and review before execution');
      if (this.db.prepare("SELECT id FROM plans WHERE org=? AND status IN ('unknown','executing')").get(this.organizationId)) throw new Error('Another write is executing or has an unknown outcome. Inspect the journal and Billy.');
      plan.executorPid=process.pid;
      const result = this.db.prepare("UPDATE plans SET status='executing',data=? WHERE id=? AND org=? AND status='prepared'").run(JSON.stringify(plan),planId,this.organizationId);
      if (result.changes !== 1) throw new Error('Plan already claimed');
      this.event(planId,'executing'); this.db.exec('COMMIT'); return plan;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  finish(planId: string, status: 'completed'|'unknown'|'rejected', result: any) {
    const plan = this.plan(planId); plan.result=result; plan.status=status;
    this.db.prepare('UPDATE plans SET status=?,data=? WHERE id=? AND org=?').run(status,JSON.stringify(plan),planId,this.organizationId);
    this.event(planId,status); return plan;
  }
  refresh(planId: string, snapshots: any[]) {
    const plan = this.plan(planId);
    if (!['prepared','rejected'].includes(plan.status)) throw new Error('Only unexecuted/rejected plans can be refreshed');
    plan.snapshots=snapshots; plan.hash=digest({intent:digest({organizationId:this.organizationId,operation:plan.operation}),snapshots}); plan.createdAt=new Date().toISOString(); plan.status='prepared'; delete plan.result;
    this.db.prepare("UPDATE plans SET status='prepared',data=?,hash=? WHERE id=? AND org=? AND status IN ('prepared','rejected')").run(JSON.stringify(plan),plan.hash,planId,this.organizationId);
    return plan;
  }
  recover(planId:string, outcome:'applied'|'not_applied', evidence:string) {
    const plan=this.plan(planId);
    if(!['unknown','executing'].includes(plan.status))throw new Error('Only uncertain/interrupted writes need recovery');
    this.event(planId,`operator recovery ${outcome}: ${evidence}`);
    const status=outcome==='applied'?'resolved_applied':'rejected';
    plan.status=status;plan.result={operatorVerified:outcome,evidence,previousResult:plan.result};
    this.db.prepare('UPDATE plans SET status=?,data=? WHERE id=? AND org=?').run(status,JSON.stringify(plan),planId,this.organizationId);
    return plan;
  }
  bankLineBooked(bankLineId:string) {return Boolean(this.db.prepare("SELECT id FROM plans WHERE org=? AND status IN ('completed','resolved_applied') AND json_extract(data,'$.operation.kind') IN ('create_payment','create_journal') AND json_extract(data,'$.operation.bankLineId')=?").get(this.organizationId,bankLineId));}
  plans() {return (this.db.prepare('SELECT data,status FROM plans WHERE org=? ORDER BY rowid DESC LIMIT 200').all(this.organizationId) as any[]).map(r=>({...JSON.parse(r.data),status:r.status}));}
  batch(batchId:string):Batch {
    const row=this.db.prepare('SELECT data,status FROM batches WHERE id=? AND org=?').get(batchId,this.organizationId) as {data:string;status:Batch['status']}|undefined;
    if(!row)throw new Error('Unknown batch');return {...JSON.parse(row.data),status:row.status};
  }
  prepareBatch(spec:any,snapshots:any[]):Batch {
    const intent=digest({organizationId:this.organizationId,spec}),hash=digest({intent,snapshots});
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.db.prepare('SELECT id FROM batches WHERE org=? AND intent=?').get(this.organizationId,intent) as {id:string}|undefined;
      if(row){const existing=this.batch(row.id);if(existing.hash!==hash)throw new Error(`Batch ${existing.id} has stale initial snapshots; refresh it before any execution.`);this.db.exec('COMMIT');return existing;}
      const batch:Batch={id:randomUUID(),intent,hash,spec,snapshots,createdAt:new Date().toISOString(),status:'prepared',stages:{}};
      this.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?,?)').run(batch.id,this.organizationId,intent,hash,batch.status,JSON.stringify(batch));
      this.db.exec('COMMIT');return batch;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  refreshBatch(batchId:string,snapshots:any[]):Batch {
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const batch=this.batch(batchId);
      if(batch.status==='running'||batch.status==='completed'||Object.values(batch.stages).some(stage=>stage.status==='completed'||this.plan(stage.planId).status==='completed'))throw new Error('Only a batch with no completed stages can be refreshed. Make a new batch for remaining cases after partial execution.');
      batch.snapshots=snapshots;batch.hash=digest({intent:batch.intent,snapshots});batch.status='prepared';batch.stages={};delete batch.approval;delete batch.error;
      this.db.prepare("UPDATE batches SET hash=?,status='prepared',data=? WHERE id=? AND org=?").run(batch.hash,JSON.stringify(batch),batchId,this.organizationId);
      this.db.exec('COMMIT');return batch;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  approveBatch(batchId:string,hash:string,approval:Batch['approval']) {
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const batch=this.batch(batchId);
      if(batch.hash!==hash||batch.status==='running'||batch.status==='completed')throw new Error('Batch changed or is already running; approval was not recorded.');
      batch.approval=approval;
      this.db.prepare('UPDATE batches SET data=? WHERE id=? AND org=?').run(JSON.stringify(batch),batchId,this.organizationId);
      this.db.exec('COMMIT');return batch;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  claimBatch(batchId:string,hash:string):BatchLease {
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const active=this.db.prepare("SELECT id,data FROM batches WHERE org=? AND status='running'").get(this.organizationId) as {id:string;data:string}|undefined;
      if(active){const running=JSON.parse(active.data) as Batch;
        if(running.runnerPid&&processAlive(running.runnerPid))throw new Error('A company batch is already running.');
        this.db.prepare("UPDATE batches SET status='paused',data=? WHERE id=? AND org=? AND status='running'").run(JSON.stringify({...running,status:'paused',runnerPid:undefined,leaseNonce:undefined,error:'Batch runner exited; inspect child plans before resuming.'}),running.id,this.organizationId);
      }
      if(this.db.prepare("SELECT id FROM plans WHERE org=? AND status IN ('unknown','executing')").get(this.organizationId))throw new Error('An uncertain or executing write blocks batch execution. Inspect the journal and Billy.');
      const batch=this.batch(batchId);
      if(batch.hash!==hash||!['prepared','paused'].includes(batch.status)||batch.approval?.scopeHash!==hash)throw new Error('Batch hash, status or approval does not permit execution.');
      const lease={batchId,nonce:randomUUID()};batch.runnerPid=process.pid;batch.leaseNonce=lease.nonce;batch.status='running';delete batch.error;
      this.db.prepare("UPDATE batches SET status='running',data=? WHERE id=? AND org=? AND status IN ('prepared','paused')").run(JSON.stringify(batch),batchId,this.organizationId);
      this.db.exec('COMMIT');return lease;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  saveBatchStage(lease:BatchLease,key:string,stage:BatchStage) {
    const batch=this.batch(lease.batchId);
    if(batch.status!=='running'||batch.leaseNonce!==lease.nonce||batch.runnerPid!==process.pid)throw new Error('Batch lease is no longer active.');
    batch.stages[key]=stage;
    this.db.prepare("UPDATE batches SET data=? WHERE id=? AND org=? AND status='running'").run(JSON.stringify(batch),batch.id,this.organizationId);
  }
  finishBatch(lease:BatchLease,status:'paused'|'completed',error?:string) {
    const batch=this.batch(lease.batchId);
    if(batch.status!=='running'||batch.leaseNonce!==lease.nonce||batch.runnerPid!==process.pid)throw new Error('Batch lease is no longer active.');
    batch.status=status;delete batch.runnerPid;delete batch.leaseNonce;if(error)batch.error=error;else delete batch.error;
    this.db.prepare('UPDATE batches SET status=?,data=? WHERE id=? AND org=?').run(status,JSON.stringify(batch),batch.id,this.organizationId);return batch;
  }
  importReceipt(filePath: string, source: any, metadata: any): Receipt {
    const actual = realpathSync(filePath), inbox = realpathSync(this.inbox), rel = relative(inbox,actual);
    if (rel.startsWith('..') || isAbsolute(rel) || !rel) throw new Error('Receipt must be a file inside the configured receipt inbox (symlinks outside are rejected)');
    const stat = statSync(actual); if (!stat.isFile() || stat.size<4 || stat.size>20*1024*1024) throw new Error('Receipt must be a regular file, 4 bytes to 20 MB');
    const bytes=readFileSync(actual);
    const mime=bytes.subarray(0,5).toString()==='%PDF-'?'application/pdf':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255 && bytes[1]===216 && bytes[2]===255?'image/jpeg':undefined;
    if (!mime) throw new Error('Only PDF, PNG and JPEG original receipts are supported');
    const receiptId=createHash('sha256').update(bytes).digest('hex');
    const existing=this.db.prepare('SELECT data FROM receipts WHERE org=? AND id=?').get(this.organizationId,receiptId) as any;
    if (existing) {
      const receipt=JSON.parse(existing.data) as Receipt;
      if (canonical(receipt.metadata)!==canonical(metadata)) throw new Error('Same document has conflicting extracted metadata; resolve before importing');
      if (!receipt.sources.some(s=>canonical(s)===canonical(source))) {receipt.sources.push(source);this.saveReceipt(receipt);}
      return receipt;
    }
    const path=join(this.root,'receipts',receiptId);writeFileSync(path,bytes,{mode:0o600});chmodSync(path,0o600);
    const receipt: Receipt={id:receiptId,path,name:basename(actual),mime,sources:[source],metadata};this.saveReceipt(receipt);return receipt;
  }
  saveReceipt(receipt: Receipt) {this.db.prepare('INSERT OR REPLACE INTO receipts VALUES(?,?,?)').run(receipt.id,this.organizationId,JSON.stringify(receipt));}
  receipt(receiptId: string): Receipt {const row=this.db.prepare('SELECT data FROM receipts WHERE org=? AND id=?').get(this.organizationId,receiptId) as any;if(!row)throw new Error('Unknown receipt');return JSON.parse(row.data);}
  receipts(): Receipt[] {return (this.db.prepare('SELECT data FROM receipts WHERE org=?').all(this.organizationId) as any[]).map(r=>JSON.parse(r.data));}
  receiptBytes(receiptId: string) {const r=this.receipt(receiptId), bytes=readFileSync(r.path);if(createHash('sha256').update(bytes).digest('hex')!==r.id)throw new Error('Archived receipt was modified');return {receipt:r,bytes};}
  vendor(vendor: any) {this.db.prepare('INSERT OR REPLACE INTO vendors VALUES(?,?,?)').run(vendor.id,this.organizationId,JSON.stringify(vendor));return vendor;}
  vendors() {return (this.db.prepare('SELECT data FROM vendors WHERE org=?').all(this.organizationId) as any[]).map(r=>JSON.parse(r.data));}
}
