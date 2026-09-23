import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {BillyClient,resources,type Resource} from '../src/client.js';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {operation,receiptMetadata,sanitizeSource} from '../src/schemas.js';
import type {Config} from '../src/config.js';
import {resolveCompany} from '../src/config.js';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'billy-test-')),inbox=join(root,'inbox');mkdirSync(inbox);
  const cfg:Config={token:'secret-test-token',organizationId:'example-company',dataDir:root,inbox,writes:true,bankMatching:true};
  const store=new Store(root,inbox,'example-company');
  const records:Record<string,any>={contacts:{supplier:{id:'supplier',name:'Vendor Ltd',isSupplier:true}},
    accounts:{expense:{id:'expense',isArchived:false},bank:{id:'bank',isBankAccount:true,isPaymentEnabled:true,currencyId:'DKK'},payable:{id:'payable',isArchived:false,systemRole:'accountsPayable',currencyId:'DKK'},fx:{id:'fx',isArchived:false,systemRole:'realizedCurrencyDifference',currencyId:'DKK'}},
    taxRates:{vat:{id:'vat',rate:0.25,isActive:true,appliesToPurchases:true}},attachments:{},bills:{},bankPayments:{},
    daybooks:{daybook:{id:'daybook'}},daybookTransactions:{},transactions:{},bankLines:{line:{id:'line',accountId:'bank',matchId:'match',amount:125,side:'credit',entryDate:'2026-09-01'}},
    bankLineMatches:{match:{id:'match',isApproved:false,lines:[{id:'line'}],subjectAssociations:[]}},bankLineSubjectAssociations:{},
    postings:{posting:{id:'posting',accountId:'bank',amount:125,side:'credit',entryDate:'2026-09-01',isBankMatched:false}}};
  const calls:{method:string;path:string;body:any}[]=[];
  let failure:string|undefined;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname.replace('/v2/',''),[resource,key]=path.split('/');
    const method=init?.method||'GET';
    const body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
    calls.push({method,path,body});
    if(failure===`${method}:${resource}`)throw new Error('simulated network loss');
    if(failure===`reject:${resource}`&&method!=='GET')return Response.json({error:'Invalid payload'},{status:422});
    if(path==='organization')return Response.json({organization:{id:'example-company',name:'Example Company',baseCurrencyId:'DKK'}});
    if(method==='GET'){
      if(key)return Response.json({[resources[resource as Resource]]:records[resource!]?.[key]});
      let values=Object.values(records[resource!]||{}) as any[];
      for(const k of ['ownerReference','contactId','suppliersInvoiceNo','accountId','transactionId','entryDate'])if(url.searchParams.has(k))values=values.filter(v=>v[k]===url.searchParams.get(k));
      return Response.json({[resource!]:values,meta:{paging:{pageCount:1}}});
    }
    if(resource==='files'){
      records.attachments.attachment={id:'attachment',fileId:'file'};
      return Response.json({files:[{id:'file'}],attachments:[records.attachments.attachment]});
    }
    const single=resources[resource as Resource],payload=body[single];
    const record={...(key?records[resource!][key]:{}),...payload,id:key||`${resource}-new`};
    if(resource==='bills'&&payload.lines){
      record.lines=payload.lines.map((line:any,index:number)=>{
        const rate=records.taxRates[line.taxRateId].rate;
        const amount=payload.taxMode==='incl'?line.amount/(1+rate):line.amount;
        return {...line,id:`bill-line-${index}`,amount,tax:amount*rate};
      });
      record.amount=record.lines.reduce((sum:number,line:any)=>sum+line.amount,0);
      record.tax=record.lines.reduce((sum:number,line:any)=>sum+line.tax,0);
      if(failure==='alter:bill-account')record.lines[0].accountId='diverted';
    }
    records[resource!][record.id]=record;
    if(resource==='daybookTransactions'&&failure==='alter:journal')record.lines=[];
    if(resource==='daybookTransactions'&&payload.state==='approved'&&failure==='alter:approve-lines')record.lines[0].accountId='diverted';
    if(resource==='bills'&&payload.attachmentIds)records.attachments[payload.attachmentIds[0].id].ownerReference=`bill:${record.id}`;
    if(resource==='bankPayments'){
      const [type,id]=payload.associations[0].subjectReference.split(':');
      const subject=records[`${type}s`][id],cashAccount=records.accounts[payload.cashAccountId];
      const subjectAmount=cashAccount.currencyId===subject.currencyId?payload.cashAmount:payload.cashAmount/payload.cashExchangeRate;
      const originalRate=Number(subject.exchangeRate||1);
      const realizedCurrencyDifference=payload.cashAmount-subjectAmount*originalRate;
      subject.balance-=subjectAmount;subject.isPaid=Math.abs(subject.balance)<0.005;
      record.subjectCurrencyId=subject.currencyId;record.cashExchangeRate=payload.cashExchangeRate||1;
      record.associations=[{subjectReference:payload.associations[0].subjectReference,amount:-subjectAmount,entryDate:payload.entryDate,modifierReference:`bankPayment:${record.id}`,realizedCurrencyDifference,isVoided:false}];
      subject.balanceModifiers=[...(subject.balanceModifiers||[]),record.associations[0]];
      if(cashAccount.currencyId!==subject.currencyId){
        const liabilityAmount=Math.round(subjectAmount*originalRate*100)/100;
        const differenceAmount=Math.round((payload.cashAmount-liabilityAmount)*100)/100;
        const transaction={id:'payment-transaction',entryDate:payload.entryDate,originatorReference:`bankPayment:${record.id}`,isVoided:false,isVoid:false,postings:[
          {id:'payment-bank-posting',transactionId:'payment-transaction',accountId:payload.cashAccountId,amount:payload.cashAmount,side:'credit',currencyId:cashAccount.currencyId,isVoided:false},
          {id:'payment-payable-posting',transactionId:'payment-transaction',accountId:'payable',amount:liabilityAmount,side:'debit',currencyId:cashAccount.currencyId,isVoided:false},
          ...(differenceAmount? [{id:'payment-fx-posting',transactionId:'payment-transaction',accountId:'fx',amount:Math.abs(differenceAmount),side:differenceAmount>0?'debit':'credit',currencyId:cashAccount.currencyId,isVoided:false}]:[]),
        ]};
        records.transactions[transaction.id]=transaction;
        for(const posting of transaction.postings)records.postings[posting.id]=posting;
        if(failure==='wrong:fx-ledger')records.postings['payment-fx-posting'].amount+=1;
      }
      if(failure==='wrong:payment-balance')subject.balance+=1;
    }
    if(resource==='bankLineMatches'&&payload.isApproved){records.postings.posting.isBankMatched=true;records.bankLines.line.isReconciled=true;}
    return Response.json({[resource!]:[record]});
  };
  const client=new BillyClient(cfg.token,'example-company',fetcher,async()=>{}),engine=new Engine(client,store,cfg);
  const metadata={supplier:'Vendor Ltd',invoiceNumber:'INV-1',invoiceDate:'2026-09-01',currencyId:'DKK',netAmount:100,vatAmount:25,totalAmount:125};
  const file=join(inbox,'invoice.pdf');writeFileSync(file,'%PDF-1.4\nfixture original document\n%%EOF');
  const receipt=()=>store.importReceipt(file,{kind:'local',reference:'fixture'},metadata);
  return {cfg,store,records,calls,client,engine,metadata,file,receipt,fail:(v:string)=>{failure=v;}};
}
test('receipt import deduplicates across vendor and email provenance',()=>{
  const f=fixture(),r=f.receipt();const second=f.store.importReceipt(f.file,{kind:'vendor_portal',reference:'https://vendor.example/billing'},f.metadata);
  assert.equal(second.id,r.id);assert.equal(second.sources.length,2);assert.equal(f.store.receipts().length,1);f.store.close();
});
test('receipt metadata conflicts and files escaping inbox are rejected',()=>{
  const f=fixture();f.receipt();assert.throws(()=>f.store.importReceipt(f.file,{}, {...f.metadata,totalAmount:200}),/conflicting/);
  const outside=join(f.cfg.dataDir,'outside.pdf');writeFileSync(outside,'%PDF-test');const link=join(f.cfg.inbox,'link.pdf');symlinkSync(outside,link);
  assert.throws(()=>f.store.importReceipt(link,{},f.metadata),/inside/);f.store.close();
});
test('archive detects modified content before upload',()=>{const f=fixture(),r=f.receipt();writeFileSync(r.path,'%PDF-tampered');assert.throws(()=>f.store.receiptBytes(r.id),/modified/);f.store.close();});
test('portal provenance strips signed query strings',()=>{assert.equal(sanitizeSource({kind:'vendor_portal',reference:'https://vendor.example/invoices?token=secret#fragment'}).reference,'https://vendor.example');});
test('schemas reject invalid dates, unbalanced journals and ambiguous precision',()=>{
  assert.equal(receiptMetadata.safeParse({supplier:'X',invoiceNumber:'1',invoiceDate:'2026-02-30',currencyId:'DKK',netAmount:1,vatAmount:0,totalAmount:1}).success,false);
  assert.equal(operation.safeParse({kind:'create_journal',daybookId:'d',entryDate:'2026-09-01',description:'Entry',noReceiptReason:'Bank transfer statement',lines:[{accountId:'a',text:'a',amount:10,side:'debit',currencyId:'DKK'},{accountId:'b',text:'b',amount:9,side:'credit',currencyId:'DKK'}]}).success,false);
  assert.equal(operation.safeParse({kind:'create_payment',cashAmount:1.001}).success,false);
});
test('organization mismatch stops before accounting reads',async()=>{
  let calls=0;const client=new BillyClient('secret','example-company',async()=>{calls++;return Response.json({organization:{id:'other'}});});
  await assert.rejects(client.verifyOrganization(),/mismatch/);assert.equal(calls,1);
});
test('company is discovered from the token with no Example Company hardcoding',async()=>{
  const f=fixture();f.cfg.organizationId='';
  const client=new BillyClient('different-company-token','',async()=>Response.json({organization:{id:'another-company',name:'Another Company'}}));
  await resolveCompany(f.cfg,client);
  assert.equal(f.cfg.organizationId,'another-company');assert.equal(client.organizationId,'another-company');
  await client.verifyOrganization();f.store.close();
});
test('pagination visits all pages and ignores untrusted nextUrl',async()=>{
  const pages:number[]=[];const client=new BillyClient('secret','example-company',async(input)=>{
    const url=new URL(String(input));assert.equal(url.host,'api.billysbilling.com');const page=Number(url.searchParams.get('page'));pages.push(page);
    return Response.json({bills:[{id:`bill${page}`}],meta:{paging:{pageCount:3,nextUrl:'https://evil.example/token'}}});
  });assert.equal((await client.list('bills')).length,3);assert.deepEqual(pages,[1,2,3]);
});
test('pagination detects duplicates and refuses partial inventories',async()=>{
  const client=new BillyClient('secret','example-company',async()=>Response.json({bills:[{id:'same'}],meta:{paging:{pageCount:3}}}));
  await assert.rejects(client.list('bills'),/pagination/);
  const many=new BillyClient('secret','example-company',async(input)=>Response.json({bills:[{id:new URL(String(input)).searchParams.get('page')}],meta:{paging:{pageCount:3}}}));
  await assert.rejects(many.list('bills',{},1),/exceeded/);
});
test('read 429 retries are bounded, writes are never retried, token is redacted',async()=>{
  let reads=0;const read=new BillyClient('secret','example-company',async()=>{reads++;return reads<3?Response.json({error:'rate'},{status:429}):Response.json({organization:{id:'example-company'}});},async()=>{});
  await read.verifyOrganization();assert.equal(reads,3);
  let writes=0;const write=new BillyClient('secret','example-company',async()=>{writes++;return Response.json({error:'secret'},{status:503});});
  await assert.rejects(write.write('bills',{}),e=>e instanceof Error&&e.message.includes('[REDACTED]')&&!e.message.includes('secret'));assert.equal(writes,1);
});
test('upload, bill draft with receipt, approval and payment read back successfully',async()=>{
  const f=fixture(),receipt=f.receipt();
  const upload=await f.engine.prepare({kind:'upload_receipt',receiptId:receipt.id},'Upload original invoice');
  const uploaded=await f.engine.execute(upload.id,upload.hash);assert.equal(uploaded.status,'completed');
  const op={kind:'create_bill',receiptId:receipt.id,contactId:'supplier',entryDate:'2026-09-01',currencyId:'DKK',suppliersInvoiceNo:'INV-1',taxMode:'incl',lines:[{accountId:'expense',taxRateId:'vat',description:'Hosting',amount:125}]};
  const draft=await f.engine.prepare(op,'Supplier invoice reviewed');const done=await f.engine.execute(draft.id,draft.hash);assert.equal(done.result.state,'draft');
  const before=f.calls.filter(c=>c.method==='POST').length;await f.engine.execute(draft.id,draft.hash);assert.equal(f.calls.filter(c=>c.method==='POST').length,before);
  await assert.rejects(f.engine.prepare(op,'Duplicate should fail'),/already exists/);
  const approve=await f.engine.prepare({kind:'approve',resource:'bills',id:'bills-new'},'Reviewed amounts VAT and receipt');await f.engine.execute(approve.id,approve.hash);
  f.records.bills['bills-new'].balance=125;
  const payment=await f.engine.prepare({kind:'create_payment',entryDate:'2026-09-01',cashAmount:125,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bills-new'},'Bank statement confirms payment');
  await f.engine.execute(payment.id,payment.hash);assert.equal(f.records.bills['bills-new'].balance,0);f.store.close();
});
test('unknown upload outcome blocks repeats and other company writes durably',async()=>{
  const f=fixture(),r=f.receipt();const plan=await f.engine.prepare({kind:'upload_receipt',receiptId:r.id},'Upload invoice evidence');f.fail('POST:files');
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/unknown/);assert.equal(f.store.plan(plan.id).status,'unknown');
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/unknown/);
  const other=await f.engine.prepare({kind:'create_contact',name:'Other supplier',countryId:'DK',isSupplier:true,isCustomer:false},'Verified new supplier');
  await assert.rejects(f.engine.execute(other.id,other.hash),/unknown/);
  f.store.close();const reopened=new Store(f.cfg.dataDir,f.cfg.inbox,'example-company');assert.equal(reopened.plan(plan.id).status,'unknown');reopened.close();
});
test('stale snapshot blocks approval, refresh changes the authorization hash',async()=>{
  const f=fixture();f.records.daybookTransactions.journal={id:'journal',state:'draft',description:'Original',lines:[{accountId:'expense',amount:100}]};
  const plan=await f.engine.prepare({kind:'approve',resource:'daybookTransactions',id:'journal'},'Reviewed payroll entry');
  f.records.daybookTransactions.journal.description='Changed';
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/changed/);assert.equal(f.store.plan(plan.id).status,'rejected');
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
  const fresh=await f.engine.refresh(plan.id);assert.notEqual(fresh.hash,plan.hash);
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/hash mismatch/);
  await f.engine.execute(fresh.id,fresh.hash);f.store.close();
});
test('write switch and company scoping are enforced',async()=>{
  const f=fixture(),r=f.receipt();const plan=await f.engine.prepare({kind:'upload_receipt',receiptId:r.id},'Upload receipt');f.cfg.writes=false;
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/disabled/);
  const other=new Store(f.cfg.dataDir,f.cfg.inbox,'other');assert.throws(()=>other.plan(plan.id),/Unknown/);assert.equal(other.receipts().length,0);other.close();f.store.close();
});
test('concurrent attempts execute a proposal at most once',async()=>{
  const f=fixture(),r=f.receipt(),plan=await f.engine.prepare({kind:'upload_receipt',receiptId:r.id},'Upload receipt once');
  const outcomes=await Promise.allSettled([f.engine.execute(plan.id,plan.hash),f.engine.execute(plan.id,plan.hash)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='files').length,1);f.store.close();
});
test('reconciliation matches existing Salary-like posting without creating an expense',async()=>{
  const f=fixture();const plan=await f.engine.prepare({kind:'reconcile',bankLineId:'line',subjectReference:'posting:posting'},'Statement reference matches existing entry');
  await f.engine.execute(plan.id,plan.hash);assert.equal(f.records.postings.posting.isBankMatched,true);
  assert.deepEqual(f.calls.filter(c=>c.method!=='GET').map(c=>c.path),['bankLineSubjectAssociations','bankLineMatches/match']);f.store.close();
});
test('grouped, mismatched and already matched bank lines are rejected',async()=>{
  const f=fixture(),op={kind:'reconcile',bankLineId:'line',subjectReference:'posting:posting'};
  f.records.postings.posting.amount=100;await assert.rejects(f.engine.prepare(op,'Match bank posting'),/amount/);
  f.records.postings.posting.amount=125;f.records.bankLineMatches.match.lines.push({id:'extra'});await assert.rejects(f.engine.prepare(op,'Match bank posting'),/Grouped/);
  f.records.bankLineMatches.match.lines.pop();f.records.postings.posting.isBankMatched=true;await assert.rejects(f.engine.prepare(op,'Match bank posting'),/already/);f.store.close();
});
test('bank matching gate, overpayment and foreign currency fail before writes',async()=>{
  const f=fixture();f.cfg.bankMatching=false;await assert.rejects(f.engine.prepare({kind:'reconcile',bankLineId:'line',subjectReference:'posting:posting'},'Match reviewed posting'),/live-verified/);
  f.records.bills.bill={id:'bill',state:'approved',balance:100,currencyId:'DKK'};
  const op={kind:'create_payment',entryDate:'2026-09-01',cashAmount:125,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bill'};
  await assert.rejects(f.engine.prepare(op,'Confirmed payment'),/exceeds/);f.records.bills.bill.currencyId='USD';await assert.rejects(f.engine.prepare(op,'Confirmed payment'),/exceeds|Foreign/);f.store.close();
});
test('same-currency payment rejects an already approved remote match with an empty local journal',async()=>{
  const f=fixture();
  f.records.bills.bill={id:'bill',state:'approved',balance:125,currencyId:'DKK'};
  f.records.bankLineMatches.match.isApproved=true;
  assert.equal(f.records.bankLines.line.isReconciled,undefined);
  assert.equal(f.store.bankLineBooked('line'),false);
  const op={kind:'create_payment',entryDate:'2026-09-01',cashAmount:125,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bill'};
  try {
    await assert.rejects(f.engine.prepare(op,'Existing remote bank match must block payment'),/unapproved/);
    assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
  }finally{f.store.close();}
});
test('payment requires an inspectable empty single-line remote match',async()=>{
  for(const change of [
    (f:any)=>{delete f.records.bankLines.line.matchId;},
    (f:any)=>{delete f.records.bankLineMatches.match.isApproved;},
    (f:any)=>{delete f.records.bankLineMatches.match.lines;},
    (f:any)=>{delete f.records.bankLineMatches.match.subjectAssociations;},
    (f:any)=>{f.records.bankLineMatches.match.lines.push({id:'other'});},
    (f:any)=>{f.records.bankLineMatches.match.lines=[{id:'other'}];},
    (f:any)=>{f.records.bankLineMatches.match.subjectAssociations=[{subjectReference:'posting:existing'}];},
  ]){
    const f=fixture();f.records.bills.bill={id:'bill',state:'approved',balance:125,currencyId:'DKK'};change(f);
    try {
      await assert.rejects(f.engine.prepare({kind:'create_payment',entryDate:'2026-09-01',cashAmount:125,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bill'},'Reject missing or occupied remote bank match'),/match|associations/);
      assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
    }finally{f.store.close();}
  }
});
test('payment rechecks remote approval and associations immediately before writing',async()=>{
  for(const change of [
    (f:any)=>{f.records.bankLineMatches.match.isApproved=true;},
    (f:any)=>{f.records.bankLineMatches.match.subjectAssociations=[{subjectReference:'posting:existing'}];},
  ]){
    const f=fixture();f.records.bills.bill={id:'bill',state:'approved',balance:125,currencyId:'DKK'};
    try {
      const plan=await f.engine.prepare({kind:'create_payment',entryDate:'2026-09-01',cashAmount:125,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bill'},'Preview an initially empty remote bank match');
      assert.ok(plan.snapshots.some(s=>s.resource==='bankLineMatches'&&s.id==='match'));
      change(f);
      await assert.rejects(f.engine.execute(plan.id,plan.hash),/unapproved|associations/);
      assert.equal(f.store.plan(plan.id).status,'rejected');
      assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
      assert.equal(f.records.bills.bill.balance,125);
    }finally{f.store.close();}
  }
});
test('foreign full settlement requires complete, matching FX evidence',async()=>{
  const f=fixture();
  f.records.bankLines.line={...f.records.bankLines.line,amount:140,entryDate:'2026-02-10'};
  f.records.bills.bill={id:'bill',state:'approved',balance:20,currencyId:'USD',exchangeRate:6.5,balanceModifiers:[]};
  const base={kind:'create_payment',entryDate:'2026-02-10',cashAmount:140,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bill',subjectAmount:20,subjectCurrencyId:'USD',cashExchangeRate:7};
  assert.equal(operation.safeParse({...base,subjectAmount:undefined}).success,false);
  await assert.rejects(f.engine.prepare({...base,subjectAmount:19},'Rate does not explain the bank amount'),/cashExchangeRate/);
  await assert.rejects(f.engine.prepare({...base,subjectCurrencyId:'DKK'},'Wrong subject currency'),/currency/);
  await assert.rejects(f.engine.prepare({...base,cashExchangeRate:6.5},'Wrong settlement rate'),/explain/);
  const plan=await f.engine.prepare(base,'Full USD bill settlement reviewed against exact bank line');
  assert.equal(plan.status,'prepared');f.store.close();
});
test('foreign full settlement sends documented FX payload, verifies zero balance and is idempotent',async()=>{
  const f=fixture();
  f.records.bankLines.line={...f.records.bankLines.line,amount:140,entryDate:'2026-02-10'};
  f.records.bills.bill={id:'bill',state:'approved',balance:20,currencyId:'USD',exchangeRate:6.5,balanceModifiers:[]};
  const op={kind:'create_payment',entryDate:'2026-02-10',cashAmount:140,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bill',subjectAmount:20,subjectCurrencyId:'USD',cashExchangeRate:7};
  const plan=await f.engine.prepare(op,'Full USD bill settlement reviewed against exact bank line');
  const done=await f.engine.execute(plan.id,plan.hash);
  assert.equal(done.status,'completed');assert.equal(f.records.bills.bill.balance,0);assert.equal(f.records.bills.bill.isPaid,true);
  const paymentCall=f.calls.find(c=>c.method==='POST'&&c.path==='bankPayments');assert.ok(paymentCall);
  assert.deepEqual(paymentCall.body.bankPayment,{entryDate:'2026-02-10',cashAmount:140,cashSide:'credit',cashAccountId:'bank',cashExchangeRate:7,associations:[{subjectReference:'bill:bill'}]});
  const writes=f.calls.filter(c=>c.method==='POST'&&c.path==='bankPayments').length;const replay=await f.engine.execute(plan.id,plan.hash);
  assert.equal(replay.status,'completed');assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='bankPayments').length,writes);f.store.close();
});
test('foreign payment rejects a wrong post-write balance and records an unknown outcome',async()=>{
  const f=fixture();
  f.records.bankLines.line={...f.records.bankLines.line,amount:140,entryDate:'2026-02-10'};
  f.records.bills.bill={id:'bill',state:'approved',balance:20,currencyId:'USD',exchangeRate:6.5,balanceModifiers:[]};
  const op={kind:'create_payment',entryDate:'2026-02-10',cashAmount:140,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bill',subjectAmount:20,subjectCurrencyId:'USD',cashExchangeRate:7};
  const plan=await f.engine.prepare(op,'Full USD bill settlement with read-back guard');f.fail('wrong:payment-balance');
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/balance|fully paid/);assert.equal(f.store.plan(plan.id).status,'unknown');f.store.close();
});
test('foreign payment rejects a corrupted realized FX ledger posting',async()=>{
  const f=fixture();
  f.records.bankLines.line={...f.records.bankLines.line,amount:140,entryDate:'2026-02-10'};
  f.records.bills.bill={id:'bill',state:'approved',balance:20,currencyId:'USD',exchangeRate:6.5,balanceModifiers:[]};
  const op={kind:'create_payment',entryDate:'2026-02-10',cashAmount:140,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bill',subjectAmount:20,subjectCurrencyId:'USD',cashExchangeRate:7};
  const plan=await f.engine.prepare(op,'Full USD bill settlement with ledger verification');f.fail('wrong:fx-ledger');
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/currency-difference|balance/);assert.equal(f.store.plan(plan.id).status,'unknown');f.store.close();
});
test('definitive first-write 422 is rejected, not an unknown global block',async()=>{
  const f=fixture(),r=f.receipt(),plan=await f.engine.prepare({kind:'upload_receipt',receiptId:r.id},'Upload original invoice');
  f.fail('reject:files');await assert.rejects(f.engine.execute(plan.id,plan.hash),/422/);assert.equal(f.store.plan(plan.id).status,'rejected');
  const other=await f.engine.prepare({kind:'create_contact',name:'New supplier',countryId:'DK',isSupplier:true,isCustomer:false},'Verified supplier');
  assert.equal((await f.engine.execute(other.id,other.hash)).status,'completed');f.store.close();
});
test('wrong VAT on a created draft fails verification and blocks approval',async()=>{
  const f=fixture(),r=f.receipt();const upload=await f.engine.prepare({kind:'upload_receipt',receiptId:r.id},'Original receipt upload');await f.engine.execute(upload.id,upload.hash);
  f.records.taxRates.vat.rate=0;
  const plan=await f.engine.prepare({kind:'create_bill',receiptId:r.id,contactId:'supplier',entryDate:'2026-09-01',currencyId:'DKK',suppliersInvoiceNo:'INV-1',taxMode:'incl',lines:[{accountId:'expense',taxRateId:'vat',description:'Hosting',amount:125}]},'Test incorrect VAT choice');
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/supporting document/);
  assert.equal(f.store.plan(plan.id).status,'unknown');assert.equal(f.records.bills['bills-new'].state,'draft');
  await assert.rejects(f.engine.prepare({kind:'approve',resource:'bills',id:'bills-new'},'Try to approve wrong VAT'),/supporting document/);f.store.close();
});
test('bill creation rejects a diverted account with unchanged totals',async()=>{
  const f=fixture(),r=f.receipt();r.attachmentId='attachment';f.store.saveReceipt(r);f.records.attachments.attachment={id:'attachment'};
  const op={kind:'create_bill',receiptId:r.id,contactId:'supplier',entryDate:'2026-09-01',currencyId:'DKK',suppliersInvoiceNo:'INV-1',taxMode:'incl',
    lines:[{accountId:'expense',taxRateId:'vat',description:'Hosting',amount:125}]};
  const plan=await f.engine.prepare(op,'Verify exact bill account');f.fail('alter:bill-account');
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/account/);
  assert.equal(f.store.plan(plan.id).status,'unknown');f.store.close();
});
test('approval rejects a changed line after a successful state update',async()=>{
  const f=fixture();f.records.daybookTransactions.journal={id:'journal',state:'draft',entryDate:'2026-09-01',lines:[{id:'line',accountId:'expense',amount:100,side:'debit',currencyId:'DKK'}]};
  const plan=await f.engine.prepare({kind:'approve',resource:'daybookTransactions',id:'journal'},'Approve reviewed journal');
  f.fail('alter:approve-lines');await assert.rejects(f.engine.execute(plan.id,plan.hash),/financial identity/);
  assert.equal(f.store.plan(plan.id).status,'unknown');f.store.close();
});
test('equal instalments are distinct by bank line and cannot be silently replayed',async()=>{
  const f=fixture();f.records.bills.bill={id:'bill',state:'approved',balance:250,currencyId:'DKK'};
  const op={kind:'create_payment',entryDate:'2026-09-01',cashAmount:125,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bill'};
  const first=await f.engine.prepare(op,'First verified instalment');await f.engine.execute(first.id,first.hash);
  await assert.rejects(f.engine.prepare(op,'Same line again'),/already executed/);
  f.records.bankLines.line2={...f.records.bankLines.line,id:'line2',matchId:'match2'};
  f.records.bankLineMatches.match2={id:'match2',isApproved:false,lines:[{id:'line2'}],subjectAssociations:[]};
  const second=await f.engine.prepare({...op,bankLineId:'line2'},'Second verified instalment');assert.notEqual(first.id,second.id);
  await f.engine.execute(second.id,second.hash);assert.equal(f.records.bills.bill.balance,0);f.store.close();
});
test('draft snapshot embeds lines so a changed account blocks approval',async()=>{
  const f=fixture();f.records.daybookTransactions.journal={id:'journal',state:'draft',lines:[{accountId:'expense',amount:100}]};
  const plan=await f.engine.prepare({kind:'approve',resource:'daybookTransactions',id:'journal'},'Review original account');
  f.records.daybookTransactions.journal.lines[0].accountId='other';
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/changed/);assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);f.store.close();
});
test('journal draft verifies lines and refuses dropped API lines',async()=>{
  const f=fixture();f.records.postings={};f.fail('alter:journal');
  const plan=await f.engine.prepare({kind:'create_journal',daybookId:'daybook',entryDate:'2026-09-01',description:'Bank fee',bankLineId:'line',noReceiptReason:'Bank statement is the supporting record',lines:[{accountId:'expense',text:'Bank fee',amount:125,side:'debit',currencyId:'DKK'},{accountId:'bank',text:'Bank fee',amount:125,side:'credit',currencyId:'DKK'}]},'Reviewed bank fee without VAT');
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/lines/);assert.equal(f.store.plan(plan.id).status,'unknown');f.store.close();
});
test('duplicate supplier contacts do not permit duplicate supplier invoices',async()=>{
  const f=fixture(),r=f.receipt();r.attachmentId='attachment';f.store.saveReceipt(r);f.records.attachments.attachment={id:'attachment'};
  f.records.contacts.alias={...f.records.contacts.supplier,id:'alias'};
  f.records.bills.duplicate={id:'duplicate',contactId:'alias',suppliersInvoiceNo:'INV-1'};
  await assert.rejects(f.engine.prepare({kind:'create_bill',receiptId:r.id,contactId:'supplier',entryDate:'2026-09-01',currencyId:'DKK',suppliersInvoiceNo:'INV-1',taxMode:'incl',lines:[{accountId:'expense',taxRateId:'vat',description:'Hosting',amount:125}]},'Should detect alias duplicate'),/already exists/);f.store.close();
});
test('supplier rename matches verified country and registration, not name alone when registration conflicts',async()=>{
  const f=fixture();f.records.contacts.supplier={...f.records.contacts.supplier,name:'Old legal name',countryId:'DK',registrationNo:'12345678'};
  const r=f.store.importReceipt(f.file,{kind:'local',reference:'fixture'},{...f.metadata,supplier:'New legal name',supplierRegistrationNo:'DK12345678',supplierCountryId:'DK'});
  r.attachmentId='attachment';f.store.saveReceipt(r);f.records.attachments.attachment={id:'attachment'};
  const op={kind:'create_bill',receiptId:r.id,contactId:'supplier',entryDate:'2026-09-01',currencyId:'DKK',suppliersInvoiceNo:'INV-1',taxMode:'incl',lines:[{accountId:'expense',taxRateId:'vat',description:'Hosting',amount:125}]};
  assert.equal((await f.engine.prepare(op,'Verified legal entity rename')).status,'prepared');
  f.records.contacts.supplier.countryId='SE';await assert.rejects(f.engine.prepare(op,'Wrong country must fail'),/identity/);
  f.records.contacts.supplier.countryId='DK';f.records.contacts.supplier.name='New legal name';f.records.contacts.supplier.registrationNo='99999999';await assert.rejects(f.engine.prepare(op,'Same name wrong registration'),/identity/);f.store.close();
});
test('operator recovery preserves applied result and does not replay remote writes',async()=>{
  const f=fixture(),r=f.receipt(),plan=await f.engine.prepare({kind:'upload_receipt',receiptId:r.id},'Upload receipt evidence');
  f.fail('POST:files');await assert.rejects(f.engine.execute(plan.id,plan.hash));
  f.store.recover(plan.id,'applied','Operator verified full result in Billy attachment record.');
  await assert.rejects(f.engine.execute(plan.id,plan.hash),/resolved_applied/);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);f.store.close();
});
test('overview applies period and reconciled filters locally',async()=>{
  const f=fixture();f.records.bankLines.old={...f.records.bankLines.line,id:'old',entryDate:'2025-01-01'};f.records.bankLines.done={...f.records.bankLines.line,id:'done',isReconciled:true};
  f.records.bills.old={id:'old',entryDate:'2025-01-01'};
  const report=await f.engine.overview('2026-09-01','2026-09-22');assert.deepEqual(report.unreconciledBankLines.map(l=>l.id),['line']);assert.equal(report.bills.length,0);f.store.close();
});
test('two independent processes cannot claim simultaneous company writes',async()=>{
  const f=fixture(),plan=f.store.prepare({kind:'test'},[],'Cross-process lock verification');
  const code=`import {Store} from './dist/store.js';const [root,inbox,id,hash]=process.argv.slice(1);const s=new Store(root,inbox,'example-company');try{s.claim(id,hash);process.stdout.write('claimed');}catch{process.exitCode=2;}finally{s.close();}`;
  const run=()=>new Promise<{exit:number|null;output:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code,f.cfg.dataDir,f.cfg.inbox,plan.id,plan.hash],{stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('exit',exit=>resolve({exit,output}));
  });
  const results=await Promise.all([run(),run()]);assert.equal(results.filter(r=>r.exit===0&&r.output.includes('claimed')).length,1);assert.equal(results.filter(r=>r.exit===2).length,1,JSON.stringify(results));f.store.close();
});
