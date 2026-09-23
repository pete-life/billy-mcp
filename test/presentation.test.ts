import {test} from 'node:test';
import assert from 'node:assert/strict';
import {presentGet,presentList,presentOverview,presentPlan,presentStatus,safeValue} from '../src/presentation.js';

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

test('status, overview and plan defaults preserve decision-critical fields without paths',()=>{
  const status=presentStatus({tokenConfigured:true,organizationId:'org',writesEnabled:true,bankMatchingEnabled:false,
    receiptInbox:'/private/inbox',dataDirectory:'/private/data',organization:{id:'org',name:'Example'}},false);
  assert.equal(status.organizationId,'org');assert.doesNotMatch(JSON.stringify(status),/private/);
  const overview=presentOverview({period:{start:'2026-09-01',end:'2026-09-30'},unreconciledBankLines:[{id:'line',accountId:'bank',amount:10,
    candidatePostings:[{id:'posting',text:'Sensitive',entryDate:'2026-09-02'}],note:'check'}],bills:[],receipts:[{id:'receipt',name:'invoice.pdf',path:'/private/a'}],
    vendors:[{id:'vendor',name:'Example',status:'ready',portalUrl:'https://example.test'}],completion:'Inventory only'},false);
  assert.equal(overview.counts.unreconciledBankLines,1);
  assert.equal(overview.unreconciledBankLines[0].candidatePostings[0].id,'posting');
  assert.doesNotMatch(JSON.stringify(overview),/private|Sensitive|https/);
  const plan=presentPlan({id:'plan',hash:'hash',status:'prepared',createdAt:'2026-09-01',reason:'Pay bill',
    operation:{kind:'create_payment',cashAmount:10,bankLineId:'line',accessCode:'bad'},
    snapshots:[{resource:'bills',id:'bill',hash:'snapshot-hash',record:{contactName:'Private'}}]},false);
  assert.equal(plan.hash,'hash');assert.equal((plan.operation as any).cashAmount,10);
  assert.deepEqual(plan.snapshots,[{resource:'bills',id:'bill',hash:'snapshot-hash'}]);
  assert.doesNotMatch(JSON.stringify(plan),/Private|accessCode|bad/);
});
