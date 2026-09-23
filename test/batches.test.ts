import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BillyClient,resources,type Resource} from '../src/client.js';
import {Engine} from '../src/engine.js';
import type {ApprovalGate} from '../src/approval.js';
import {BatchManager} from '../src/batches.js';
import {Store,digest,type BatchLease} from '../src/store.js';
import type {Config} from '../src/config.js';

function fixture(bankMatching=false){
  const root=mkdtempSync(join(tmpdir(),'billy-batches-')),inbox=join(root,'inbox');
  const store=new Store(root,inbox,'fixture-company');
  const records:Record<string,any>={
    'contacts:contact-1':{id:'contact-1',name:'Vendor One',isSupplier:true,countryId:'DK'},
    'contacts:contact-2':{id:'contact-2',name:'Vendor Two',isSupplier:true,countryId:'DK'},
    'accounts:expense':{id:'expense',isArchived:false},
    'accounts:bank':{id:'bank',isArchived:false,isPaymentEnabled:true},
    'taxRates:vat':{id:'vat',isActive:true,appliesToPurchases:true},
    'bankLines:line-1':{id:'line-1',accountId:'bank',entryDate:'2026-09-20',side:'credit',amount:125,isReconciled:false,matchId:'match-1'},
    'bankLineMatches:match-1':{id:'match-1',isApproved:false,lines:[{id:'line-1'}],subjectAssociations:[]},
  };
  const getCalls:Array<{resource:string;id:string;include?:string}>=[];
  const client={verifyOrganization:async()=>({id:'fixture-company',defaultBankFeeAccountId:'fees'}),get:async(resource:string,id:string,include?:string)=>{
    getCalls.push({resource,id,include});
    const record=records[`${resource}:${id}`];if(!record)throw new Error(`Missing fixture ${resource}:${id}`);return structuredClone(record);
  },list:async()=>[]} as unknown as BillyClient;
  const receipts=[1,2].map(number=>{
    const path=join(inbox,`receipt-${number}.pdf`);writeFileSync(path,`%PDF-1.4\nfixture-${number}`);
    return store.importReceipt(path,{kind:'local',reference:`receipt-${number}`},{supplier:`Vendor ${number===1?'One':'Two'}`,invoiceNumber:`INV-${number}`,invoiceDate:'2026-09-20',currencyId:'DKK',netAmount:100,vatAmount:25,totalAmount:125});
  });
  const spec={reason:'Book the two verified fixture invoices',cases:receipts.map((receipt,index)=>({receiptId:receipt.id,bill:{contactId:`contact-${index+1}`,entryDate:'2026-09-20',currencyId:'DKK',suppliersInvoiceNo:`INV-${index+1}`,taxMode:'excl',lines:[{accountId:'expense',taxRateId:'vat',description:'Fixture service',amount:100}]},approve:true,reconcile:false}))};
  const writes:string[]=[];
  let failBeforeSecondBill=false,unknownSecondBill=false,rejectBill='';
  let afterWrite:(op:any)=>void=()=>{};
  const billRecords:Record<string,any>={};
  const planSnapshots=(op:any)=>op.kind==='create_bill'?[{taxRate:records['taxRates:vat'].rate??0,contactRegistration:records[`contacts:${op.contactId}`]?.registrationNo}]:op.kind==='approve'?[{resource:'bills',id:op.id,hash:digest(billRecords[op.id]),record:structuredClone(billRecords[op.id])}]:[];
  const engine={config:{writes:true,approvalMode:'trusted_automation',bankMatching},prepare:async(op:any,reason:string)=>{
    if(failBeforeSecondBill&&op.kind==='create_bill'&&op.suppliersInvoiceNo==='INV-2'){failBeforeSecondBill=false;throw new Error('Temporary fixture read failure');}
    return store.prepare(op,planSnapshots(op),reason);
  },execute:async(planId:string,hash:string,lease?:BatchLease)=>{
    const plan=store.claim(planId,hash,lease),op=plan.operation;
    writes.push(`${op.kind}:${op.suppliersInvoiceNo||op.receiptId||op.id||''}`);
    if(rejectBill&&op.kind==='create_bill'&&op.suppliersInvoiceNo===rejectBill){
      rejectBill='';store.finish(planId,'rejected',{error:'Definitive fixture rejection'});throw new Error('Definitive fixture rejection');
    }
    if(unknownSecondBill&&op.kind==='create_bill'&&op.suppliersInvoiceNo==='INV-2'){
      store.finish(planId,'unknown',{error:'Uncertain fixture write'});throw new Error('Uncertain fixture write');
    }
    let result:any={id:op.id||`${op.kind}-${writes.length}`};
    if(op.kind==='upload_receipt'){
      const receipt=store.receipt(op.receiptId);receipt.attachmentId=`attachment-${writes.length}`;store.saveReceipt(receipt);
      result={receiptId:receipt.id,attachment:{id:receipt.attachmentId}};
    }
    if(op.kind==='create_bill'){
      result={...op,id:`bill-${op.suppliersInvoiceNo}`,state:'draft',amount:100,tax:25,lines:op.lines.map((line:any)=>({...line,amount:100,tax:25}))};
      billRecords[result.id]=structuredClone(result);
    }
    const done=store.finish(planId,'completed',result);afterWrite(op);return done;
  },refresh:async(planId:string)=>store.refresh(planId,planSnapshots(store.plan(planId).operation)),resolvePaymentCashPosting:async(planId:string)=>{
    const plan=store.plan(planId);assert.equal(plan.status,'completed');assert.equal(plan.operation.kind,'create_payment');
    return {postingId:'posting-1',paymentId:'payment-1',bankLineId:plan.operation.bankLineId};
  }} as unknown as Engine;
  let approvalCount=0;
  let approvalSideEffect:(()=>void)|undefined;
  const approval={authorize:async(scope:{hash:string})=>{approvalCount++;approvalSideEffect?.();return {mode:'trusted_automation',at:new Date().toISOString(),scopeHash:scope.hash};}} as unknown as ApprovalGate;
  const manager=new BatchManager(client,engine,store,approval);
  return {root,inbox,store,records,billRecords,spec,manager,writes,getCalls,get approvalCount(){return approvalCount;},failOnce(){failBeforeSecondBill=true;},unknownOnce(){unknownSecondBill=true;},rejectOnce(invoiceNo='INV-2'){rejectBill=invoiceNo;},onApproval(effect:()=>void){approvalSideEffect=effect;},onStageWrite(effect:(op:any)=>void){afterWrite=effect;},close(){store.close();rmSync(root,{recursive:true,force:true});}};
}

test('two-case purchase batch executes upload, bill and approval in order with one approval',async()=>{
  const f=fixture();try{
    const batch=await f.manager.prepare(f.spec),result=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch');
    assert.equal(result.status,'completed');assert.equal(f.approvalCount,1);
    assert.deepEqual(f.writes.map(item=>item.split(':')[0]),['upload_receipt','create_bill','approve','upload_receipt','create_bill','approve']);
    assert.equal((await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch')).status,'completed');
    assert.equal(f.writes.length,6);
    assert.ok(!('leaseNonce' in f.manager.get(batch.id)));
  }finally{f.close();}
});
test('middle failure pauses and resumes without repeating completed child writes',async()=>{
  const f=fixture();try{
    f.failOnce();const batch=await f.manager.prepare(f.spec);
    const paused=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch') as any;
    assert.equal(paused.stopped,true);assert.equal(paused.batch.status,'paused');
    assert.match(paused.error,/Temporary fixture/);assert.equal(f.writes.filter(item=>item.startsWith('create_bill:INV-1')).length,1);
    const done=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch');
    assert.equal(done.status,'completed');assert.equal(f.approvalCount,1);
    assert.equal(f.writes.filter(item=>item.startsWith('create_bill:INV-1')).length,1);
    assert.equal(f.writes.filter(item=>item.startsWith('create_bill:INV-2')).length,1);
  }finally{f.close();}
});
test('definitively rejected child can be refreshed and resumed with unchanged snapshots',async()=>{
  const f=fixture();try{
    f.rejectOnce();const batch=await f.manager.prepare(f.spec);
    const partial=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch') as any;
    assert.equal(partial.stopped,true);assert.match(partial.error,/Definitive fixture rejection/);
    const done=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch');
    assert.equal(done.status,'completed');assert.equal(f.approvalCount,1);
    assert.equal(f.writes.filter(item=>item.startsWith('create_bill:INV-1')).length,1);
    assert.equal(f.writes.filter(item=>item.startsWith('create_bill:INV-2')).length,2);
  }finally{f.close();}
});
test('dependent payment and reconciliation resolve only the verified cash posting',async()=>{
  const f=fixture(true);try{
    f.spec.cases=f.spec.cases.slice(0,1);
    const item=f.spec.cases[0] as any;
    item.payment={entryDate:'2026-09-20',cashAmount:125,cashSide:'credit',cashAccountId:'bank',bankLineId:'line-1'};
    item.reconcile=true;
    const batch=await f.manager.prepare(f.spec),done=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch');
    assert.equal(done.status,'completed',JSON.stringify(done));
    assert.ok(f.getCalls.some(call=>call.resource==='bankLineMatches'&&call.include==='bankLineMatch.lines:embed,bankLineMatch.subjectAssociations:embed'));
    assert.deepEqual(f.writes.map(item=>item.split(':')[0]),['upload_receipt','create_bill','approve','create_payment','reconcile']);
    const reconcile=f.store.plan((done.stages as any)['0:reconcile'].planId);
    assert.equal(reconcile.operation.subjectReference,'posting:posting-1');
  }finally{f.close();}
});
test('material change between upload and bill stops before the next financial write',async()=>{
  const f=fixture();try{
    f.spec.cases=f.spec.cases.slice(0,1);
    f.onStageWrite(op=>{if(op.kind==='upload_receipt')f.records['contacts:contact-1'].name='Changed supplier';});
    const batch=await f.manager.prepare(f.spec);
    const partial=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch') as any;
    assert.equal(partial.stopped,true);assert.match(partial.error,/supplier name/);
    assert.deepEqual(f.writes.map(item=>item.split(':')[0]),['upload_receipt']);
    f.records['contacts:contact-1'].name='Vendor One';
    const done=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch');
    assert.equal(done.status,'completed');assert.equal(f.approvalCount,1);
    assert.deepEqual(f.writes.map(item=>item.split(':')[0]),['upload_receipt','create_bill','approve']);
  }finally{f.close();}
});
test('edited bill lines are rejected from the saved approval plan before approval write',async()=>{
  const f=fixture();try{
    f.spec.cases=f.spec.cases.slice(0,1);
    f.onStageWrite(op=>{if(op.kind==='create_bill')f.billRecords['bill-INV-1'].lines[0].accountId='diverted';});
    const batch=await f.manager.prepare(f.spec);
    const partial=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch') as any;
    assert.equal(partial.stopped,true);assert.match(partial.error,/Approval plan bill identity or lines differ/);
    assert.deepEqual(f.writes.map(item=>item.split(':')[0]),['upload_receipt','create_bill']);
    assert.equal(partial.batch.stages['0:approve'].status,'prepared');
    assert.equal(partial.batch.stages['0:bill'].recordId,'bill-INV-1');
    assert.ok(!('snapshots' in partial.batch));
    assert.ok(!('leaseNonce' in partial.batch));
  }finally{f.close();}
});
test('refreshed unstarted batch accepts refreshed rejected child under new approval hash',async()=>{
  const f=fixture();try{
    f.spec.cases=f.spec.cases.slice(0,1);
    const receipt=f.store.receipt(f.spec.cases[0]!.receiptId);receipt.attachmentId='preuploaded';f.store.saveReceipt(receipt);
    f.rejectOnce('INV-1');
    const original=await f.manager.prepare(f.spec);
    const partial=await f.manager.execute(original.id,original.hash,'Fixture authorization for first scope') as any;
    assert.equal(partial.stopped,true);assert.equal(partial.batch.status,'paused');
    assert.equal(f.writes.length,1);
    f.records['contacts:contact-1'].registrationNo='12345678';
    const refreshed=await f.manager.refresh(original.id);
    assert.notEqual(refreshed.hash,original.hash);assert.equal(refreshed.approval,undefined);
    const done=await f.manager.execute(refreshed.id,refreshed.hash,'Fixture authorization for refreshed scope');
    assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(f.approvalCount,2);
    assert.equal(f.writes.filter(item=>item.startsWith('create_bill:INV-1')).length,2);
  }finally{f.close();}
});
test('typed fee payment snapshots the configured fee account',async()=>{
  const f=fixture();try{
    f.spec.cases=f.spec.cases.slice(0,1);
    f.records['accounts:fees']={id:'fees',isArchived:false,currencyId:'DKK'};
    const item=f.spec.cases[0] as any;
    item.payment={entryDate:'2026-09-20',cashAmount:125,cashSide:'credit',cashAccountId:'bank',bankLineId:'line-1',subjectAmount:120,feeAmount:5,feeAccountId:'fees'};
    const batch=await f.manager.prepare(f.spec);
    assert.ok((f.store.batch(batch.id).snapshots[0] as any).records.some((record:any)=>record.resource==='accounts'&&record.id==='fees'));
    f.records['accounts:fees'].isArchived=true;
    await assert.rejects(()=>f.manager.execute(batch.id,batch.hash,'Fixture authorization for fee payment'),/archived/);
    assert.equal(f.writes.length,0);
    f.records['accounts:fees'].isArchived=false;
    const done=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for fee payment');
    assert.equal(done.status,'completed',JSON.stringify(done));
    assert.ok(f.writes.some(write=>write.startsWith('create_payment:')));
  }finally{f.close();}
});
test('preflight rejects mismatched money and more than ten cases without approval',async()=>{
  const f=fixture();try{
    const bad=structuredClone(f.spec);bad.cases[0]!.bill.lines[0]!.amount=101;
    await assert.rejects(()=>f.manager.prepare(bad),/Purchase lines/);
    assert.equal(f.approvalCount,0);assert.equal(f.writes.length,0);
    const long=structuredClone(f.spec);long.cases=Array.from({length:11},()=>structuredClone(f.spec.cases[0]!));
    await assert.rejects(()=>f.manager.prepare(long),/too_big|Too big|10|duplicate/i);
  }finally{f.close();}
});
test('evidence change after approval stops before any child write and refresh clears approval',async()=>{
  const f=fixture();try{
    const batch=await f.manager.prepare(f.spec);
    f.onApproval(()=>{f.records['contacts:contact-1'].name='Changed supplier';});
    await assert.rejects(()=>f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch'),/supplier name|initial evidence changed/);
    assert.equal(f.writes.length,0);
    assert.equal(f.approvalCount,1);
    f.records['contacts:contact-1'].name='Vendor One';
    const refreshed=await f.manager.refresh(batch.id);
    assert.equal(refreshed.approval,undefined);
  }finally{f.close();}
});
test('unknown child outcome blocks resume and all company writes',async()=>{
  const f=fixture();try{
    f.unknownOnce();const batch=await f.manager.prepare(f.spec);
    const partial=await f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch') as any;
    assert.equal(partial.stopped,true);assert.equal(partial.batch.status,'paused');
    assert.equal(partial.batch.stages['1:bill'].status,'unknown');
    assert.match(partial.batch.stages['1:bill'].error,/Uncertain fixture write/);
    await assert.rejects(()=>f.manager.execute(batch.id,batch.hash,'Fixture authorization for exact batch'),/uncertain or executing write/);
    const separate=f.store.prepare({kind:'approve',id:'other'},[],'Separate fixture operation');
    assert.throws(()=>f.store.claim(separate.id,separate.hash),/unknown outcome/);
  }finally{f.close();}
});
test('company batch lease atomically excludes separate plans and can be reclaimed after dead runner',()=>{
  const f=fixture();try{
    const batch=f.store.prepareBatch({cases:['fixture']},[]);
    f.store.approveBatch(batch.id,batch.hash,{mode:'trusted_automation',at:new Date().toISOString(),scopeHash:batch.hash});
    const lease=f.store.claimBatch(batch.id,batch.hash);
    const separate=f.store.prepare({kind:'approve',id:'other'},[],'Separate fixture operation');
    assert.throws(()=>f.store.claim(separate.id,separate.hash),/batch owns company writes/);
    assert.throws(()=>f.store.claimBatch(batch.id,batch.hash),/already running/);
    const owned=f.store.prepare({kind:'approve',id:'owned'},[],'Owned fixture operation');
    assert.equal(f.store.claim(owned.id,owned.hash,lease).status,'prepared');
    f.store.finish(owned.id,'completed',{id:'owned'});
    f.store.finishBatch(lease,'paused');
    const script=`import {Store} from './dist/store.js';const s=new Store(process.argv[1],process.argv[2],'fixture-company');s.claimBatch(process.argv[3],process.argv[4]);s.close();`;
    execFileSync(process.execPath,['--input-type=module','-e',script,f.root,f.inbox,batch.id,batch.hash],{cwd:process.cwd()});
    const reclaimed=f.store.claimBatch(batch.id,batch.hash);
    assert.notEqual(reclaimed.nonce,lease.nonce);
    f.store.finishBatch(reclaimed,'paused');
  }finally{f.close();}
});
for(const taxMode of ['excl','incl'] as const)test(`real Engine runs a ${taxMode}-tax purchase batch through its guarded plan claims`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'billy-real-batch-')),inbox=join(root,'inbox');
  const store=new Store(root,inbox,'fixture-company');
  const cfg:Config={token:'fixture-token',organizationId:'fixture-company',dataDir:root,inbox,writes:true,bankMatching:false,approvalMode:'trusted_automation'};
  const data:Record<string,Record<string,any>>={
    contacts:{supplier:{id:'supplier',name:'Vendor Ltd',isSupplier:true,countryId:'DK'}},
    accounts:{expense:{id:'expense',isArchived:false}},taxRates:{vat:{id:'vat',rate:0.25,isActive:true,appliesToPurchases:true}},
    attachments:{},bills:{},
  };
  const writes:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname.replace('/v2/',''),[resource,key]=path.split('/');
    const method=init?.method||'GET';
    if(path==='organization')return Response.json({organization:{id:'fixture-company',name:'Fixture Company'}});
    if(method==='GET'){
      if(key)return Response.json({[resources[resource as Resource]]:data[resource!]?.[key]});
      let values=Object.values(data[resource!]||{});
      for(const field of ['suppliersInvoiceNo','minEntryDate','maxEntryDate','ownerReference']){
        if(url.searchParams.has(field)){
          const value=url.searchParams.get(field);
          values=values.filter(record=>field==='minEntryDate'?record.entryDate>=value!:field==='maxEntryDate'?record.entryDate<=value!:record[field]===value);
        }
      }
      return Response.json({[resource!]:values,meta:{paging:{pageCount:1}}});
    }
    writes.push(`${method}:${path}`);
    if(resource==='files'){
      data.attachments!.attachment={id:'attachment',fileId:'file'};
      return Response.json({files:[{id:'file'}],attachments:[data.attachments!.attachment]});
    }
    const body=JSON.parse(String(init!.body)),single=resources[resource as Resource],payload=body[single];
    const record={...(key?data[resource!]![key]:{}),...payload,id:key||'bill-1'};
    if(resource==='bills'&&!key){record.amount=100;record.tax=25;record.lines=record.lines.map((line:any)=>({...line,amount:100,tax:25}));data.attachments!.attachment.ownerReference='bill:bill-1';}
    data[resource!]![record.id]=record;
    return Response.json({[resource!]:[record]});
  };
  try{
    const client=new BillyClient(cfg.token,cfg.organizationId,fetcher,async()=>{}),engine=new Engine(client,store,cfg);
    const approval={authorize:async(scope:{hash:string})=>({mode:'trusted_automation',at:new Date().toISOString(),scopeHash:scope.hash})} as unknown as ApprovalGate;
    const manager=new BatchManager(client,engine,store,approval);
    const path=join(inbox,'original.pdf');writeFileSync(path,'%PDF-1.4\nfixture invoice\n%%EOF');
    const receipt=store.importReceipt(path,{kind:'local',reference:'fixture-original'},{supplier:'Vendor Ltd',invoiceNumber:'INV-1',invoiceDate:'2026-09-20',currencyId:'DKK',netAmount:100,vatAmount:25,totalAmount:125});
    const spec={reason:'Fixture purchase with a verified receipt',cases:[{receiptId:receipt.id,bill:{contactId:'supplier',entryDate:'2026-09-20',currencyId:'DKK',suppliersInvoiceNo:'INV-1',taxMode,lines:[{accountId:'expense',taxRateId:'vat',description:'Fixture service',amount:taxMode==='incl'?125:100}]},approve:true,reconcile:false}]};
    const batch=await manager.prepare(spec),done=await manager.execute(batch.id,batch.hash,'Fixture approval for exact purchase batch');
    assert.equal(done.status,'completed',JSON.stringify(done));
    assert.deepEqual(writes,['POST:files','POST:bills','PUT:bills/bill-1']);
    assert.equal(store.plan((done.stages as any)['0:approve'].planId).status,'completed');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
