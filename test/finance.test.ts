import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BillyClient,resources,type Resource} from '../src/client.js';
import {Engine} from '../src/engine.js';
import {Store} from '../src/store.js';
import type {Config} from '../src/config.js';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'billy-finance-')),inbox=join(root,'inbox');mkdirSync(inbox);
  const config:Config={token:'fixture-token',organizationId:'fixture-org',dataDir:root,inbox,writes:true,bankMatching:true};
  const store=new Store(root,inbox,config.organizationId);
  const records:Record<string,Record<string,any>>={
    contacts:{customer:{id:'customer',isCustomer:true,isArchived:false}},contactPersons:{person:{id:'person',contactId:'customer',email:'customer@example.test'}},
    products:{product:{id:'product',accountId:'sales',salesTaxRulesetId:'rules',isArchived:false}},
    salesTaxRulesets:{rules:{id:'rules',fallbackTaxRateId:'vat'}},taxRates:{vat:{id:'vat',rate:.25,isActive:true,appliesToSales:true}},
    accounts:{sales:{id:'sales',isArchived:false},bank:{id:'bank',isArchived:false,isPaymentEnabled:true,currencyId:'DKK'},fee:{id:'fee',isArchived:false},
      payable:{id:'payable',isArchived:false,systemRole:'accountsPayable'},receivable:{id:'receivable',isArchived:false,systemRole:'accountsReceivable'},
      fx:{id:'fx',isArchived:false,systemRole:'realizedCurrencyDifference'}},
    invoices:{},bills:{},bankPayments:{},bankLines:{line:{id:'line',accountId:'bank',matchId:'match',entryDate:'2026-09-01',side:'debit',amount:95}},
    bankLineMatches:{match:{id:'match',isApproved:false,lines:[{id:'line'}],subjectAssociations:[]}},transactions:{},postings:{},
  };
  const calls:{method:string;path:string;body:any}[]=[];
  let failure='';
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname.replace('/v2/',''),[resource,key,action]=path.split('/');
    const method=init?.method||'GET',body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
    calls.push({method,path,body});
    if(failure===`transport:${method}:${path}`)throw new Error('simulated transport loss');
    if(path==='organization')return Response.json({organization:{id:'fixture-org',baseCurrencyId:'DKK',defaultBankFeeAccountId:'fee'}});
    if(method==='GET'){
      if(key)return Response.json({[resources[resource as Resource]]:records[resource]?.[key]});
      let values=Object.values(records[resource]||{});
      if(url.searchParams.has('creditedInvoiceId'))values=values.filter(v=>v.creditedInvoiceId===url.searchParams.get('creditedInvoiceId'));
      if(url.searchParams.has('entryDate'))values=values.filter(v=>v.entryDate===url.searchParams.get('entryDate'));
      return Response.json({[resource]:values,meta:{paging:{pageCount:1}}});
    }
    if(resource==='invoices'&&action==='emails'){
      records.invoices[key].sentState=failure==='bad:send'?'unsent':'sent';
      return Response.json({accepted:true});
    }
    const payload=body[resources[resource as Resource]],record={...(key?records[resource]?.[key]:{}),...payload,id:key||`${resource}-${Object.keys(records[resource]||{}).length+1}`};
    if(resource==='invoices'&&payload.lines){
      record.type=payload.type||'invoice';record.sentState='unsent';
      record.lines=payload.lines.map((line:any,index:number)=>{
        const rate=.25,base=line.quantity*line.unitPrice;
        const amount=payload.taxMode==='incl'?base/(1+rate):base;
        return {...line,id:`line-${record.id}-${index}`,invoiceId:record.id,taxRateId:'vat',amount,tax:amount*rate};
      });
      record.amount=record.lines.reduce((n:number,l:any)=>n+l.amount,0);
      record.tax=record.lines.reduce((n:number,l:any)=>n+l.tax,0);
      if(failure==='bad:invoice-tax')record.tax+=1;
    }
    if(resource==='bankPayments'){
      const [kind,id]=payload.associations[0].subjectReference.split(':'),subject=records[`${kind}s`][id];
      const foreign=subject.currencyId!=='DKK',fee=payload.feeAmount||0;
      const applied=payload.cashAmount+(payload.cashSide==='debit'?fee:-fee),amount=foreign?applied/payload.cashExchangeRate:applied;
      subject.balance=Math.round((subject.balance-amount)*100)/100;subject.isPaid=subject.balance===0;
      record.subjectCurrencyId=subject.currencyId;record.cashExchangeRate=payload.cashExchangeRate||1;
      record.associations=[{subjectReference:payload.associations[0].subjectReference,amount:-amount,modifierReference:`bankPayment:${record.id}`,isVoided:false}];
      subject.balanceModifiers=[...(subject.balanceModifiers||[]),...record.associations];
      const liability=Math.round(amount*(foreign?subject.exchangeRate:1)*100)/100,difference=Math.round((applied-liability)*100)/100;
      const ledger={id:'tx',entryDate:payload.entryDate,originatorReference:`bankPayment:${record.id}`,postings:[
        {id:'cash-posting',accountId:'bank',side:payload.cashSide,amount:payload.cashAmount,currencyId:'DKK'},
        {id:'liability-posting',accountId:kind==='bill'?'payable':'receivable',side:kind==='bill'?'debit':'credit',amount:liability,currencyId:'DKK'},
        ...(fee?[{id:'fee-posting',accountId:'fee',side:'debit',amount:fee,currencyId:'DKK'}]:[]),
        ...(difference?[{id:'fx-posting',accountId:'fx',side:difference>0?'debit':'credit',amount:Math.abs(difference),currencyId:'DKK'}]:[]),
      ]};
      if(failure==='bad:fee-ledger'&&fee)ledger.postings.find(p=>p.id==='fee-posting')!.amount+=1;
      records.transactions.tx=ledger;
      for(const posting of ledger.postings)records.postings[posting.id]=posting;
      records[resource][record.id]=record;
      return Response.json({bankPayments:[record],transactions:[ledger]});
    }
    records[resource][record.id]=record;
    return Response.json({[resource]:[record]});
  };
  const engine=new Engine(new BillyClient(config.token,config.organizationId,fetcher,async()=>{}),store,config);
  return {engine,store,records,calls,fail:(value:string)=>{failure=value;}};
}

const sales={kind:'create_sales_invoice',contactId:'customer',entryDate:'2026-09-01',currencyId:'DKK',taxMode:'excl',
  lines:[{productId:'product',salesTaxRulesetId:'rules',expectedTaxRateId:'vat',quantity:1,unitPrice:100,description:'Service'}],
  expectedNetAmount:100,expectedTaxAmount:25,expectedTotalAmount:125};

test('sales draft creation checks customer, product tax and totals; header edit snapshots lines',async()=>{
  const f=fixture();
  try{
    const plan=await f.engine.prepare(sales,'Reviewed customer service invoice');
    const done=await f.engine.execute(plan.id,plan.hash);
    assert.equal(done.result.state,'draft');assert.equal(done.result.tax,25);
    const update=await f.engine.prepare({kind:'update_draft_invoice',id:done.result.id,contactMessage:'Thank you',expectedNetAmount:100,expectedTaxAmount:25,expectedTotalAmount:125},'Reviewed invoice message');
    assert.equal((await f.engine.execute(update.id,update.hash)).result.contactMessage,'Thank you');
    const stale=await f.engine.prepare({kind:'update_draft_invoice',id:done.result.id,paymentTermsDays:14,expectedNetAmount:100,expectedTaxAmount:25,expectedTotalAmount:125},'Reviewed due terms');
    f.records.invoices[done.result.id].lines[0].unitPrice=99;
    await assert.rejects(f.engine.execute(stale.id,stale.hash),/changed/);
    assert.equal(f.calls.filter(c=>c.method==='PUT'&&c.path===`invoices/${done.result.id}`).length,1);
  }finally{f.store.close();}
});

test('invoice wrong sales tax read-back is unknown and never silently retried',async()=>{
  const f=fixture();
  try{
    const plan=await f.engine.prepare(sales,'Reviewed VAT fixture');f.fail('bad:invoice-tax');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/VAT/);
    assert.equal(f.store.plan(plan.id).status,'unknown');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/unknown/);
    assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='invoices').length,1);
  }finally{f.store.close();}
});

test('invoice sending uses a separate reviewed recipient and body with one write only',async()=>{
  const f=fixture();f.records.invoices.original={id:'original',type:'invoice',state:'approved',sentState:'unsent',contactId:'customer',lines:[{id:'line',productId:'product'}]};
  const op={kind:'send_invoice',id:'original',contactPersonId:'person',recipientEmail:'customer@example.test',emailSubject:'Invoice',emailBody:'Please see invoice'};
  try{
    await assert.rejects(f.engine.prepare({...op,recipientEmail:'wrong@example.test'},'Wrong recipient'),/Recipient/);
    const plan=await f.engine.prepare(op,'Reviewed email recipient and message');
    f.records.contactPersons.person.email='changed@example.test';
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/Recipient/);
    f.records.contactPersons.person.email='customer@example.test';
    const fresh=await f.engine.refresh(plan.id);
    const done=await f.engine.execute(fresh.id,fresh.hash);
    assert.equal(done.result.sentState,'sent');
    assert.deepEqual(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/emails')).map(c=>c.body),[{email:{contactPersonId:'person',emailSubject:'Invoice',emailBody:'Please see invoice'}}]);
  }finally{f.store.close();}
});

test('uncertain invoice send stays unknown and cannot be retried',async()=>{
  const f=fixture();f.records.invoices.original={id:'original',type:'invoice',state:'approved',sentState:'unsent',contactId:'customer',lines:[{id:'line'}]};
  try{
    const plan=await f.engine.prepare({kind:'send_invoice',id:'original',contactPersonId:'person',recipientEmail:'customer@example.test',emailSubject:'Invoice',emailBody:'Please see invoice'},'Send once');
    f.fail('transport:POST:invoices/original/emails');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/unknown/);
    assert.equal(f.store.plan(plan.id).status,'unknown');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/unknown/);
    assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/emails')).length,1);
  }finally{f.store.close();}
});

test('customer credit note binds original, limits totals and blocks duplicates',async()=>{
  const f=fixture();f.records.invoices.original={id:'original',type:'invoice',state:'approved',contactId:'customer',currencyId:'DKK',taxMode:'excl',amount:100,tax:25,
    lines:[{id:'original-line',productId:'product',taxRateId:'vat',quantity:1,unitPrice:100,amount:100,tax:25}]};
  const credit={kind:'create_customer_credit_note',originalInvoiceId:'original',entryDate:'2026-09-02',
    lines:[{originalLineId:'original-line',productId:'product',salesTaxRulesetId:'rules',expectedTaxRateId:'vat',quantity:1,unitPrice:40}],
    expectedNetAmount:40,expectedTaxAmount:10,expectedTotalAmount:50};
  try{
    const plan=await f.engine.prepare(credit,'Reviewed partial credit of original');
    const done=await f.engine.execute(plan.id,plan.hash);
    assert.equal(done.result.type,'creditNote');assert.equal(done.result.creditedInvoiceId,'original');
    await assert.rejects(f.engine.prepare({...credit,entryDate:'2026-09-03'},'Duplicate credit'),/Duplicate/);
    await assert.rejects(f.engine.prepare({...credit,entryDate:'2026-09-03',lines:[{...credit.lines[0],unitPrice:70}],expectedNetAmount:70,expectedTaxAmount:17.5,expectedTotalAmount:87.5},'Overcredit'),/exceed/);
  }finally{f.store.close();}
});

test('customer credit read-back mismatch remains an unknown financial write',async()=>{
  const f=fixture();f.records.invoices.original={id:'original',type:'invoice',state:'approved',contactId:'customer',currencyId:'DKK',taxMode:'excl',amount:100,tax:25,
    lines:[{id:'original-line',productId:'product',taxRateId:'vat',quantity:1,unitPrice:100,amount:100,tax:25}]};
  try{
    const plan=await f.engine.prepare({kind:'create_customer_credit_note',originalInvoiceId:'original',entryDate:'2026-09-02',
      lines:[{originalLineId:'original-line',productId:'product',salesTaxRulesetId:'rules',expectedTaxRateId:'vat',quantity:1,unitPrice:40}],
      expectedNetAmount:40,expectedTaxAmount:10,expectedTotalAmount:50},'Reviewed credit tax');
    f.fail('bad:invoice-tax');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/VAT/);
    assert.equal(f.store.plan(plan.id).status,'unknown');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/unknown/);
  }finally{f.store.close();}
});

test('same-currency provider fee and partial foreign bill payment verify exact ledger',async()=>{
  const f=fixture();f.records.invoices.invoice={id:'invoice',state:'approved',type:'invoice',contactId:'customer',currencyId:'DKK',balance:200,isPaid:false,balanceModifiers:[]};
  try{
    const fee={kind:'create_payment',entryDate:'2026-09-01',cashAmount:95,cashSide:'debit',cashAccountId:'bank',bankLineId:'line',subjectReference:'invoice:invoice',subjectAmount:100,feeAmount:5,feeAccountId:'fee'};
    const first=await f.engine.prepare(fee,'Provider statement explicitly shows fee');
    assert.equal((await f.engine.execute(first.id,first.hash)).result.subject.balance,100);
    const posting=await f.engine.resolvePaymentCashPosting(first.id);assert.equal(posting.postingId,'cash-posting');
    assert.equal(f.calls.find(c=>c.path==='bankPayments'&&c.method==='POST')?.body.bankPayment.feeAmount,5);
  }finally{f.store.close();}
  const g=fixture();g.records.bankLines.line.amount=70;g.records.bankLines.line.side='credit';
  g.records.bills.bill={id:'bill',state:'approved',currencyId:'USD',balance:20,isPaid:false,exchangeRate:6.5,
    balanceModifiers:[{modifierReference:'bankPayment:prior',subjectReference:'bill:bill',amount:-5,isVoided:false}]};
  try{
    const partial={kind:'create_payment',entryDate:'2026-09-01',cashAmount:70,cashSide:'credit',cashAccountId:'bank',bankLineId:'line',subjectReference:'bill:bill',subjectAmount:10,subjectCurrencyId:'USD',cashExchangeRate:7};
    await assert.rejects(g.engine.prepare({...partial,subjectCurrencyId:'EUR'},'Wrong currency'),/currency/);
    await assert.rejects(g.engine.prepare({...partial,subjectAmount:30},'Overpayment'),/exceeds/);
    const plan=await g.engine.prepare(partial,'Reviewed partial USD instalment');
    const done=await g.engine.execute(plan.id,plan.hash);
    assert.equal(done.result.subject.balance,10);assert.equal(done.result.subject.isPaid,false);
    assert.equal(done.result.subject.balanceModifiers.length,2);
    assert.equal(done.result.ledger.postings.find((p:any)=>p.accountId==='fx').amount,5);
  }finally{g.store.close();}
});

test('wrong fee ledger posting records unknown outcome',async()=>{
  const f=fixture();f.records.invoices.invoice={id:'invoice',state:'approved',currencyId:'DKK',balance:100,isPaid:false,balanceModifiers:[]};
  try{
    const op={kind:'create_payment',entryDate:'2026-09-01',cashAmount:95,cashSide:'debit',cashAccountId:'bank',bankLineId:'line',subjectReference:'invoice:invoice',subjectAmount:100,feeAmount:5,feeAccountId:'fee'};
    const plan=await f.engine.prepare(op,'Fee ledger verification');f.fail('bad:fee-ledger');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/fee expense/);
    assert.equal(f.store.plan(plan.id).status,'unknown');
  }finally{f.store.close();}
});
