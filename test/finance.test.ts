import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
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
    salesTaxRulesets:{rules:{id:'rules',fallbackTaxRateId:'vat'}},taxRates:{vat:{id:'vat',rate:.25,isActive:true,appliesToSales:true,appliesToPurchases:true}},attachments:{},
    accounts:{sales:{id:'sales',isArchived:false},bank:{id:'bank',isArchived:false,isPaymentEnabled:true,currencyId:'DKK'},fee:{id:'fee',isArchived:false},
      payable:{id:'payable',isArchived:false,systemRole:'accountsPayable'},receivable:{id:'receivable',isArchived:false,systemRole:'accountsReceivable'},
      fx:{id:'fx',isArchived:false,systemRole:'realizedCurrencyDifference'}},
    invoices:{},bills:{},bankPayments:{},bankLines:{line:{id:'line',accountId:'bank',matchId:'match',entryDate:'2026-09-01',side:'debit',amount:95}},
    bankLineMatches:{match:{id:'match',isApproved:false,lines:[{id:'line'}],subjectAssociations:[]}},transactions:{},postings:{},
  };
  const calls:{method:string;path:string;body:any}[]=[];
  let failure='',paymentSubjectGets=0,invoiceReads=0;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname.replace('/v2/',''),[resource,key,action]=path.split('/');
    const method=init?.method||'GET',body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
    calls.push({method,path,body});
    if(failure===`transport:${method}:${path}`)throw new Error('simulated transport loss');
    if(path==='organization')return Response.json({organization:{id:'fixture-org',baseCurrencyId:'DKK',defaultBankFeeAccountId:'fee'}});
    if(method==='GET'){
      if(failure==='drift:payment-subject'&&key==='invoice'&&resource==='invoices'&&++paymentSubjectGets===2)records.invoices.invoice.balance=50;
      if(key){
        const record=records[resource]?.[key];
        return Response.json({[resources[resource as Resource]]:resource==='invoices'&&record?{...record,downloadUrl:`https://example.test/download?nonce=${++invoiceReads}`}:record});
      }
      let values=Object.values(records[resource]||{});
      if(url.searchParams.has('creditedInvoiceId'))values=values.filter(v=>v.creditedInvoiceId===url.searchParams.get('creditedInvoiceId'));
      if(url.searchParams.has('creditedBillId'))values=values.filter(v=>v.creditedBillId===url.searchParams.get('creditedBillId'));
      if(url.searchParams.has('suppliersInvoiceNo'))values=values.filter(v=>v.suppliersInvoiceNo===url.searchParams.get('suppliersInvoiceNo'));
      if(url.searchParams.has('ownerReference'))values=values.filter(v=>v.ownerReference===url.searchParams.get('ownerReference'));
      if(url.searchParams.has('entryDate'))values=values.filter(v=>v.entryDate===url.searchParams.get('entryDate'));
      return Response.json({[resource]:values,meta:{paging:{pageCount:1}}});
    }
    if(resource==='invoices'&&action==='emails'){
      records.invoices[key].sentState=failure==='bad:send'?'unsent':'sent';
      return Response.json({accepted:true});
    }
    const payload=body[resources[resource as Resource]],record={...(key?records[resource]?.[key]:{}),...payload,id:key||`${resource}-${Object.keys(records[resource]||{}).length+1}`};
    if(resource==='invoices'&&payload.paymentTermsMode==='net'){
      const date=new Date(`${record.entryDate}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+payload.paymentTermsDays);
      record.dueDate=failure==='bad:due-date'?'2000-01-01':date.toISOString().slice(0,10);
    }
    if(resource==='invoices'&&key&&failure==='bad:header-lines')record.lines[0].productId='substituted-product';
    if(resource==='invoices'&&payload.state==='approved'&&failure==='bad:approve-lines')record.lines[0].productId='substituted-product';
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
    if(resource==='bills'&&payload.lines){
      record.lines=payload.lines.map((line:any,index:number)=>{
        const amount=payload.taxMode==='incl'?line.amount/1.25:line.amount;
        return {...line,id:`bill-line-${record.id}-${index}`,billId:record.id,amount,tax:amount*.25};
      });
      record.amount=record.lines.reduce((n:number,line:any)=>n+line.amount,0);
      record.tax=record.lines.reduce((n:number,line:any)=>n+line.tax,0);
      if(failure==='bad:bill-tax')record.tax+=1;
      if(payload.attachmentIds)records.attachments[payload.attachmentIds[0].id].ownerReference=`bill:${record.id}`;
    }
    if(resource==='bankPayments'){
      const [kind,id]=payload.associations[0].subjectReference.split(':'),subject=records[`${kind}s`][id];
      const foreign=subject.currencyId!=='DKK',fee=payload.feeAmount||0;
      const applied=payload.cashAmount+(payload.cashSide==='debit'?fee:-fee),amount=foreign?applied/payload.cashExchangeRate:applied;
      subject.balance=Math.round((subject.balance-amount)*100)/100;subject.isPaid=subject.balance===0;
      record.subjectCurrencyId=subject.currencyId;record.cashExchangeRate=payload.cashExchangeRate||1;
      if(failure==='bad:unexpected-fee')record.feeAmount=1;
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
  const supplierCreditReceipt=()=>{
    const path=join(inbox,'supplier-credit.pdf');writeFileSync(path,'%PDF-1.4\nsynthetic supplier credit\n%%EOF');
    const metadata={supplier:'Supplier Ltd',invoiceNumber:'CN-1',invoiceDate:'2026-09-02',currencyId:'DKK',
      documentType:'creditNote',creditedInvoiceNumber:'PUR-1',netAmount:40,vatAmount:10,totalAmount:50};
    const receipt=store.importReceipt(path,{kind:'local',reference:'synthetic-credit'},metadata);
    receipt.attachmentId='credit-attachment';store.saveReceipt(receipt);
    records.attachments['credit-attachment']={id:'credit-attachment',fileId:'synthetic-file'};
    return receipt;
  };
  return {engine,store,records,calls,fail:(value:string)=>{failure=value;paymentSubjectGets=0;},supplierCreditReceipt};
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

test('draft header edit rejects a changed product even when totals stay correct',async()=>{
  const f=fixture();
  try{
    const created=await f.engine.prepare(sales,'Create draft for line integrity');
    await f.engine.execute(created.id,created.hash);
    const plan=await f.engine.prepare({kind:'update_draft_invoice',id:'invoices-1',contactMessage:'Updated',
      expectedNetAmount:100,expectedTaxAmount:25,expectedTotalAmount:125},'Header only');
    f.fail('bad:header-lines');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/immutable lines/);
    assert.equal(f.store.plan(plan.id).status,'unknown');
    assert.equal(f.records.invoices['invoices-1'].amount,100);
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

test('customer credit quantity and unit price cannot exceed original or prior credited quantity',async()=>{
  const f=fixture();f.records.invoices.original={id:'original',type:'invoice',state:'approved',contactId:'customer',currencyId:'DKK',taxMode:'excl',amount:100,tax:25,
    lines:[{id:'original-line',productId:'product',taxRateId:'vat',quantity:1,unitPrice:100,amount:100,tax:25}]};
  const base={kind:'create_customer_credit_note',originalInvoiceId:'original',entryDate:'2026-09-02',
    lines:[{originalLineId:'original-line',productId:'product',salesTaxRulesetId:'rules',expectedTaxRateId:'vat',quantity:2,unitPrice:50}],
    expectedNetAmount:100,expectedTaxAmount:25,expectedTotalAmount:125};
  try{
    await assert.rejects(f.engine.prepare(base,'Quantity over original'),/quantity/);
    await assert.rejects(f.engine.prepare({...base,lines:[{...base.lines[0],quantity:1,unitPrice:101}]},'Unit price over original'),/unit price/);
    f.records.invoices.previous={id:'previous',type:'creditNote',state:'approved',creditedInvoiceId:'original',contactId:'customer',currencyId:'DKK',
      amount:50,tax:12.5,lines:[{id:'prior-line',productId:'product',taxRateId:'vat',quantity:.5,unitPrice:100,amount:50,tax:12.5}]};
    await assert.rejects(f.engine.prepare({...base,lines:[{...base.lines[0],quantity:.6,unitPrice:50}],
      expectedNetAmount:30,expectedTaxAmount:7.5,expectedTotalAmount:37.5},'Cumulative quantity over original'),/Cumulative credited quantity/);
    assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  }finally{f.store.close();}
});

test('credit approval rechecks newly added sibling customer and supplier credits before PUT',async()=>{
  const f=fixture();f.records.invoices.original={id:'original',type:'invoice',state:'approved',contactId:'customer',currencyId:'DKK',taxMode:'excl',amount:100,tax:25,
    lines:[{id:'original-line',productId:'product',taxRateId:'vat',quantity:1,unitPrice:100,amount:100,tax:25}]};
  f.records.invoices.first={id:'first',type:'creditNote',state:'draft',creditedInvoiceId:'original',contactId:'customer',currencyId:'DKK',taxMode:'excl',amount:60,tax:15,
    lines:[{id:'first-line',productId:'product',taxRateId:'vat',quantity:.6,unitPrice:100,amount:60,tax:15}]};
  try{
    const plan=await f.engine.prepare({kind:'approve',resource:'invoices',id:'first'},'Reviewed first customer credit');
    f.records.invoices.second={id:'second',type:'creditNote',state:'draft',creditedInvoiceId:'original',contactId:'customer',currencyId:'DKK',taxMode:'excl',amount:50,tax:12.5,
      lines:[{id:'second-line',productId:'product',taxRateId:'vat',quantity:.5,unitPrice:100,amount:50,tax:12.5}]};
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/exceed/);
    assert.equal(f.calls.filter(c=>c.method==='PUT'&&c.path==='invoices/first').length,0);
  }finally{f.store.close();}
  const g=fixture(),receipt=g.supplierCreditReceipt();g.records.contacts.supplier={id:'supplier',name:'Supplier Ltd',isSupplier:true};
  g.records.attachments[receipt.attachmentId!].ownerReference='bill:first';
  g.records.bills.original={id:'original',type:'bill',state:'approved',contactId:'supplier',currencyId:'DKK',taxMode:'incl',suppliersInvoiceNo:'PUR-1',amount:100,tax:25,
    lines:[{id:'original-line',accountId:'expense',taxRateId:'vat',amount:100,tax:25}]};
  g.records.bills.first={id:'first',type:'creditNote',state:'draft',creditedBillId:'original',contactId:'supplier',currencyId:'DKK',taxMode:'incl',
    suppliersInvoiceNo:'CN-1',entryDate:'2026-09-02',amount:40,tax:10,lines:[{id:'first-line',accountId:'expense',taxRateId:'vat',amount:40,tax:10}]};
  try{
    const plan=await g.engine.prepare({kind:'approve',resource:'bills',id:'first'},'Reviewed first supplier credit');
    g.records.bills.second={id:'second',type:'creditNote',state:'draft',creditedBillId:'original',contactId:'supplier',currencyId:'DKK',taxMode:'incl',
      suppliersInvoiceNo:'CN-2',amount:70,tax:17.5,lines:[{id:'second-line',accountId:'expense',taxRateId:'vat',amount:70,tax:17.5}]};
    await assert.rejects(g.engine.execute(plan.id,plan.hash),/exceed/);
    assert.equal(g.calls.filter(c=>c.method==='PUT'&&c.path==='bills/first').length,0);
  }finally{g.store.close();}
});

test('invoice approval readback preserves reviewed line and totals',async()=>{
  const f=fixture();f.records.invoices.draft={id:'draft',type:'invoice',state:'draft',contactId:'customer',currencyId:'DKK',taxMode:'excl',entryDate:'2026-09-01',amount:100,tax:25,
    lines:[{id:'line',productId:'product',taxRateId:'vat',quantity:1,unitPrice:100,amount:100,tax:25}]};
  try{
    const plan=await f.engine.prepare({kind:'approve',resource:'invoices',id:'draft'},'Reviewed invoice draft');
    f.fail('bad:approve-lines');await assert.rejects(f.engine.execute(plan.id,plan.hash),/financial identity/);
    assert.equal(f.store.plan(plan.id).status,'unknown');
  }finally{f.store.close();}
});

test('supplier credit note requires original bill and uploaded credit evidence, then prevents duplicate and overcredit',async()=>{
  const f=fixture(),receipt=f.supplierCreditReceipt();
  f.records.contacts.supplier={id:'supplier',name:'Supplier Ltd',isSupplier:true};
  f.records.accounts.expense={id:'expense',isArchived:false};
  f.records.bills.original={id:'original',type:'bill',state:'approved',contactId:'supplier',currencyId:'DKK',taxMode:'incl',
    suppliersInvoiceNo:'PUR-1',amount:100,tax:25,lines:[{id:'original-line',accountId:'expense',taxRateId:'vat',description:'Materials',amount:100,tax:25}]};
  const op={kind:'create_supplier_credit_note',receiptId:receipt.id,originalBillId:'original',entryDate:'2026-09-02',
    lines:[{originalLineId:'original-line',accountId:'expense',taxRateId:'vat',description:'Materials refund',amount:50}],
    expectedNetAmount:40,expectedTaxAmount:10,expectedTotalAmount:50};
  try{
    const plan=await f.engine.prepare(op,'Original supplier credit and bill reviewed');
    const done=await f.engine.execute(plan.id,plan.hash);
    assert.equal(done.result.type,'creditNote');assert.equal(done.result.creditedBillId,'original');
    assert.equal(f.records.attachments['credit-attachment'].ownerReference,`bill:${done.result.id}`);
    const secondFile=join(f.store.inbox,'duplicate-credit.pdf');writeFileSync(secondFile,'%PDF-1.4\nsecond synthetic copy\n%%EOF');
    const second=f.store.importReceipt(secondFile,{kind:'local',reference:'duplicate-fixture'},receipt.metadata);
    second.attachmentId='second-attachment';f.store.saveReceipt(second);
    f.records.attachments['second-attachment']={id:'second-attachment',fileId:'second-file'};
    await assert.rejects(f.engine.prepare({...op,receiptId:second.id},'Duplicate credit document'),/number already exists/);
  }finally{f.store.close();}
  const g=fixture(),secondReceipt=g.supplierCreditReceipt();
  g.records.contacts.supplier={id:'supplier',name:'Supplier Ltd',isSupplier:true};g.records.accounts.expense={id:'expense',isArchived:false};
  g.records.bills.original={id:'original',type:'bill',state:'approved',contactId:'supplier',currencyId:'DKK',taxMode:'incl',
    suppliersInvoiceNo:'PUR-1',amount:100,tax:25,lines:[{id:'original-line',accountId:'expense',taxRateId:'vat',description:'Materials',amount:100,tax:25}]};
  g.records.bills.previous={id:'previous',type:'creditNote',state:'approved',creditedBillId:'original',contactId:'supplier',currencyId:'DKK',
    suppliersInvoiceNo:'OLDER-CN',amount:80,tax:20,lines:[{id:'previous-line',accountId:'expense',taxRateId:'vat',description:'Earlier refund',amount:80,tax:20}]};
  try{await assert.rejects(g.engine.prepare({...op,receiptId:secondReceipt.id},'Reject cumulative overcredit'),/exceeds|exceed/);}
  finally{g.store.close();}
});

test('supplier credit bad read-back is unknown and blocks retry',async()=>{
  const f=fixture(),receipt=f.supplierCreditReceipt();
  f.records.contacts.supplier={id:'supplier',name:'Supplier Ltd',isSupplier:true};f.records.accounts.expense={id:'expense',isArchived:false};
  f.records.bills.original={id:'original',type:'bill',state:'approved',contactId:'supplier',currencyId:'DKK',taxMode:'incl',
    suppliersInvoiceNo:'PUR-1',amount:100,tax:25,lines:[{id:'original-line',accountId:'expense',taxRateId:'vat',description:'Materials',amount:100,tax:25}]};
  try{
    const plan=await f.engine.prepare({kind:'create_supplier_credit_note',receiptId:receipt.id,originalBillId:'original',entryDate:'2026-09-02',
      lines:[{originalLineId:'original-line',accountId:'expense',taxRateId:'vat',description:'Materials refund',amount:50}],
      expectedNetAmount:40,expectedTaxAmount:10,expectedTotalAmount:50},'Credit read-back fixture');
    f.fail('bad:bill-tax');
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

test('payment rechecks subject immediately before POST when balance shrinks after inspect',async()=>{
  const f=fixture();f.records.invoices.invoice={id:'invoice',state:'approved',type:'invoice',currencyId:'DKK',balance:95,isPaid:false,balanceModifiers:[]};
  try{
    const plan=await f.engine.prepare({kind:'create_payment',entryDate:'2026-09-01',cashAmount:95,cashSide:'debit',cashAccountId:'bank',
      bankLineId:'line',subjectReference:'invoice:invoice'},'Exact bank line and outstanding invoice');
    f.fail('drift:payment-subject');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/changed since the reviewed snapshot/);
    assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='bankPayments').length,0);
    assert.equal(f.store.plan(plan.id).status,'rejected');
  }finally{f.store.close();}
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

test('fractional original-liability FX split and non-base-currency fee reject before write',async()=>{
  const f=fixture();f.records.bankLines.line.amount=.07;f.records.bankLines.line.side='credit';
  f.records.bills.bill={id:'bill',state:'approved',currencyId:'USD',balance:.02,isPaid:false,exchangeRate:6.5,balanceModifiers:[]};
  try{
    await assert.rejects(f.engine.prepare({kind:'create_payment',entryDate:'2026-09-01',cashAmount:.07,cashSide:'credit',cashAccountId:'bank',
      bankLineId:'line',subjectReference:'bill:bill',subjectAmount:.01,subjectCurrencyId:'USD',cashExchangeRate:7},'Ambiguous cent split'),/ambiguous original-liability cent rounding/);
    assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  }finally{f.store.close();}
  const g=fixture();g.records.accounts.bank.currencyId='USD';g.records.invoices.invoice={id:'invoice',state:'approved',currencyId:'USD',balance:100,isPaid:false,balanceModifiers:[]};
  try{
    await assert.rejects(g.engine.prepare({kind:'create_payment',entryDate:'2026-09-01',cashAmount:95,cashSide:'debit',cashAccountId:'bank',
      bankLineId:'line',subjectReference:'invoice:invoice',subjectAmount:100,feeAmount:5,feeAccountId:'fee'},'Non-base fee'),/base-currency/);
    assert.equal(g.calls.filter(c=>c.method==='POST').length,0);
  }finally{g.store.close();}
});

test('unexpected fee on a no-fee payment is an unknown write',async()=>{
  const f=fixture();f.records.invoices.invoice={id:'invoice',state:'approved',currencyId:'DKK',balance:95,isPaid:false,balanceModifiers:[]};
  try{
    const plan=await f.engine.prepare({kind:'create_payment',entryDate:'2026-09-01',cashAmount:95,cashSide:'debit',cashAccountId:'bank',
      bankLineId:'line',subjectReference:'invoice:invoice'},'No fee on statement');
    f.fail('bad:unexpected-fee');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/fee amount/);
    assert.equal(f.store.plan(plan.id).status,'unknown');
  }finally{f.store.close();}
});


test('negative linked supplier credits cannot offset an excessive positive credit at approval',async()=>{
  const f=fixture(),receipt=f.supplierCreditReceipt();
  receipt.metadata={...receipt.metadata,netAmount:150,vatAmount:37.5,totalAmount:187.5};f.store.saveReceipt(receipt);
  f.records.contacts.supplier={id:'supplier',name:'Supplier Ltd',isSupplier:true};
  f.records.attachments[receipt.attachmentId!].ownerReference='bill:target';
  f.records.bills.original={id:'original',type:'bill',state:'approved',contactId:'supplier',currencyId:'DKK',taxMode:'excl',suppliersInvoiceNo:'PUR-1',amount:100,tax:25,
    lines:[{id:'original-line',accountId:'expense',taxRateId:'vat',amount:100,tax:25}]};
  // Negative sibling first used to lower cumulative caps before the target.
  f.records.bills.negative={id:'negative',type:'creditNote',state:'approved',creditedBillId:'original',contactId:'supplier',currencyId:'DKK',taxMode:'excl',amount:-50,tax:-12.5,
    lines:[{id:'negative-line',accountId:'expense',taxRateId:'vat',amount:-50,tax:-12.5}]};
  f.records.bills.target={id:'target',type:'creditNote',state:'draft',creditedBillId:'original',contactId:'supplier',currencyId:'DKK',taxMode:'excl',amount:150,tax:37.5,
    entryDate:'2026-09-02',suppliersInvoiceNo:'CN-1',lines:[{id:'target-line',accountId:'expense',taxRateId:'vat',amount:150,tax:37.5}]};
  try{
    await assert.rejects(f.engine.prepare({kind:'approve',resource:'bills',id:'target'},'Review excessive credit with negative sibling'),/must be nonnegative/);
    assert.equal(f.calls.filter(call=>call.method!=='GET').length,0);
  }finally{f.store.close();}
});


test('net terms tolerate rotating download links and verify due date across month boundary',async()=>{
  const f=fixture();
  try{
    const created=await f.engine.prepare({...sales,entryDate:'2026-01-30'},'Synthetic draft');
    await f.engine.execute(created.id,created.hash);
    Object.assign(f.records.invoices['invoices-1'],{paymentTermsMode:'date',paymentTermsDays:null,dueDate:null});
    const plan=await f.engine.prepare({kind:'update_draft_invoice',id:'invoices-1',paymentTermsDays:7,
      expectedNetAmount:100,expectedTaxAmount:25,expectedTotalAmount:125},'Net seven days');
    const done=await f.engine.execute(plan.id,plan.hash);
    assert.equal(done.result.paymentTermsMode,'net');assert.equal(done.result.paymentTermsDays,7);
    assert.equal(done.result.dueDate,'2026-02-06');assert.equal(done.result.state,'draft');assert.equal(done.result.sentState,'unsent');
    assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
  }finally{f.store.close();}
});

test('wrong due-date readback is unknown and cannot be retried',async()=>{
  const f=fixture();
  try{
    const created=await f.engine.prepare(sales,'Synthetic draft');await f.engine.execute(created.id,created.hash);
    const plan=await f.engine.prepare({kind:'update_draft_invoice',id:'invoices-1',paymentTermsDays:7,
      expectedNetAmount:100,expectedTaxAmount:25,expectedTotalAmount:125},'Net seven days');
    f.fail('bad:due-date');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/dueDate/);
    assert.equal(f.store.plan(plan.id).status,'unknown');
    await assert.rejects(f.engine.execute(plan.id,plan.hash),/unknown/);
    assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
  }finally{f.store.close();}
});

for(const [field,value] of Object.entries({contactId:'other',entryDate:'2026-02-02',currencyId:'EUR',paymentTermsMode:'net',dueDate:'2026-03-01',amount:200,newFinancialField:'changed'})){
  test(`invoice snapshot still rejects real drift: ${field}`,async()=>{
    const f=fixture();
    try{
      const created=await f.engine.prepare(sales,'Synthetic draft');await f.engine.execute(created.id,created.hash);
      const plan=await f.engine.prepare({kind:'update_draft_invoice',id:'invoices-1',paymentTermsDays:7,
        expectedNetAmount:100,expectedTaxAmount:25,expectedTotalAmount:125},'Net seven days');
      f.records.invoices['invoices-1'][field]=value;
      await assert.rejects(f.engine.execute(plan.id,plan.hash),/changed/);
      assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
    }finally{f.store.close();}
  });
}


for(const [entryDate,days,dueDate] of [['2028-02-28',1,'2028-02-29'],['2026-01-01',-1,'2025-12-31'],['2026-12-31',0,'2026-12-31']] as const){
  test(`net terms calendar arithmetic: ${entryDate} plus ${days}`,async()=>{
    const f=fixture();
    try{
      const created=await f.engine.prepare({...sales,entryDate},'Synthetic calendar case');await f.engine.execute(created.id,created.hash);
      const plan=await f.engine.prepare({kind:'update_draft_invoice',id:'invoices-1',paymentTermsDays:days,
        expectedNetAmount:100,expectedTaxAmount:25,expectedTotalAmount:125},'Calendar terms');
      assert.equal((await f.engine.execute(plan.id,plan.hash)).result.dueDate,dueDate);
    }finally{f.store.close();}
  });
}


test('invalid invoice date rejects net terms during preparation without writing',async()=>{
  const f=fixture();
  try{
    const created=await f.engine.prepare(sales,'Synthetic draft');await f.engine.execute(created.id,created.hash);
    f.records.invoices['invoices-1'].entryDate='2026-02-30';
    await assert.rejects(f.engine.prepare({kind:'update_draft_invoice',id:'invoices-1',paymentTermsDays:7,
      expectedNetAmount:100,expectedTaxAmount:25,expectedTotalAmount:125},'Invalid date'),/Invalid invoice entry date/);
    assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
  }finally{f.store.close();}
});
