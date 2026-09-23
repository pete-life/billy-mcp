import {test} from 'node:test';
import assert from 'node:assert/strict';
import {presentGet,presentList,presentOverview,presentPlan,presentStatus,safeValue,compactRecord} from '../src/presentation.js';

test('compact lists retain every record and financial links while reducing payload',()=>{
  const records=Array.from({length:250},(_,i)=>({id:`posting-${i}`,organizationId:'org',accountId:'expense',transactionId:`txn-${i}`,
    entryDate:'2026-09-01',amount:1.25,side:'debit',currencyId:'DKK',description:'long private description '.repeat(20),
    downloadUrl:`https://example.test/download?signature=secret-${i}`,accessCode:`secret-${i}`}));
  const compact=presentList('postings',records),verbose=presentList('postings',records,true);
  assert.equal(compact.count,250);assert.equal(compact.complete,true);assert.equal(compact.records.length,250);
  assert.deepEqual(compact.records[0],{id:'posting-0',organizationId:'org',entryDate:'2026-09-01',currencyId:'DKK',
    amount:1.25,side:'debit',accountId:'expense',transactionId:'txn-0'});
  assert.ok(JSON.stringify(compact).length<JSON.stringify(verbose).length/3);
  assert.doesNotMatch(JSON.stringify(verbose),/secret-0|accessCode|signature/);
  assert.equal((presentGet('postings',records[0]!,true).record as any).downloadUrl,undefined);
});

test('recursive sanitization removes credentials and links but preserves accounting values',()=>{
  const raw={id:'x',amount:10,tokenConfigured:true,nested:{accessCode:'abc',apiKey:'abc',signedUrl:'https://example.test/?key=abc',
    authorization:'Bearer abc',portalUrl:'https://example.test/billing',lines:[{amount:10,reference:'https://example.test/file?accessCode=abc'}]}};
  const safe=safeValue(raw);
  assert.equal((safe as any).tokenConfigured,true);
  assert.equal((safe as any).nested.lines[0].amount,10);
  assert.equal((safe as any).nested.portalUrl,'https://example.test/billing');
  assert.doesNotMatch(JSON.stringify(safe),/abc|accessCode|apiKey|signedUrl|authorization/);
});

test('status, overview and plan defaults retain workflow IDs and required local paths',()=>{
  const status=presentStatus({tokenConfigured:true,organizationId:'org',writesEnabled:true,bankMatchingEnabled:false,
    receiptInbox:'/private/inbox',dataDirectory:'/private/data',organization:{id:'org',name:'Example'}},false);
  assert.equal(status.organizationId,'org');assert.equal(status.dataDirectory,'/private/data');assert.equal(status.receiptInbox,'/private/inbox');
  const overview=presentOverview({period:{start:'2026-09-01',end:'2026-09-30'},unreconciledBankLines:[{id:'line',accountId:'bank',amount:10,
    candidatePostings:[{id:'posting',text:'Sensitive',entryDate:'2026-09-02'}],note:'check'}],bills:[],receipts:[{id:'receipt',name:'invoice.pdf',path:'/private/a'}],
    vendors:[{id:'vendor',name:'Example',status:'ready',portalUrl:'https://example.test'}],completion:'Inventory only'},false);
  assert.equal(overview.counts.unreconciledBankLines,1);
  assert.equal(overview.unreconciledBankLines[0].candidatePostings[0].id,'posting');
  assert.equal(overview.unreconciledBankLines[0].candidatePostings[0].text,'Sensitive');
  assert.doesNotMatch(JSON.stringify(overview),/private|https/);
  const plan=presentPlan({id:'plan',hash:'hash',status:'prepared',createdAt:'2026-09-01',reason:'Pay bill',
    operation:{kind:'create_payment',cashAmount:10,bankLineId:'line',accessCode:'bad'},
    snapshots:[{resource:'bills',id:'bill',hash:'snapshot-hash',record:{contactName:'Private'}}]},false);
  assert.equal(plan.hash,'hash');assert.equal((plan.operation as any).cashAmount,10);
  assert.deepEqual(plan.snapshots,[{resource:'bills',id:'bill',hash:'snapshot-hash'}]);
  assert.doesNotMatch(JSON.stringify(plan),/Private|accessCode|bad/);
});

test('compact get keeps requested embedded bill evidence and safe local file paths',()=>{
  const bill={id:'bill',organizationId:'org',state:'approved',amount:100,tax:25,grossAmount:125,taxMode:'excl',
    currencyId:'DKK',exchangeRate:1,lines:[{id:'line',accountId:'expense',taxRateId:'vat',description:'Hosting',amount:100,tax:25}],
    attachmentIds:['att'],downloadUrl:'https://example.test/?signature=secret'};
  const output=presentGet('bills',bill,false,'bill.lines:embed');
  assert.deepEqual((output.record as any).lines,[{id:'line',amount:100,tax:25,accountId:'expense',taxRateId:'vat',description:'Hosting'}]);
  assert.equal((output.record as any).grossAmount,125);assert.equal((output.record as any).exchangeRate,1);
  assert.equal((output.record as any).taxMode,'excl');assert.doesNotMatch(JSON.stringify(output),/signature|secret/);
  const operation=safeValue({filePath:'/tmp/receipts/invoice.pdf',portalUrl:'https://example.test/billing',accessCode:'secret'});
  assert.equal((operation as any).filePath,'/tmp/receipts/invoice.pdf');assert.equal((operation as any).portalUrl,'https://example.test/billing');
  assert.equal((operation as any).accessCode,undefined);
});

test('compact reads retain supplier, tax, payment and portal decision fields',()=>{
  const data={id:'record',countryId:'DK',registrationNo:'12345678',isSupplier:true,isCustomer:false,isPaymentEnabled:true,
    predefinedTag:'purchase_example',appliesToPurchases:true,salesTaxRulesetId:'rules',productId:'product',
    cashAmount:140,cashSide:'credit',cashAccountId:'bank',cashExchangeRate:7,subjectCurrencyId:'USD',feeAmount:1,
    sentState:'unsent',portalUrl:'https://vendor.example/billing',accountLabel:'company',accessCode:'never-expose'};
  const result=compactRecord(data);
  for(const [key,value] of Object.entries(data))if(key!=='accessCode')assert.deepEqual(result[key],value,key);
  assert.equal(result.accessCode,undefined);
});
