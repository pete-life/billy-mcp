import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BillyClient} from '../src/client.js';
import {Reports} from '../src/reports.js';

function fixture(){
  const records:Record<string,any[]>={
    accounts:[
      {id:'revenue',organizationId:'org',name:'Sales',accountNo:11,groupId:'income'},
      {id:'expense',organizationId:'org',name:'Costs',accountNo:22,groupId:'costs'},
      {id:'bank',organizationId:'org',name:'Bank',accountNo:33,groupId:'assets'},
    ],
    accountGroups:[{id:'income',natureId:'credit-nature'},{id:'costs',natureId:'debit-nature'},{id:'assets',natureId:'asset-nature'}],
    accountNatures:[{id:'credit-nature',reportType:'incomeStatement',normalBalance:'credit'},
      {id:'debit-nature',reportType:'incomeStatement',normalBalance:'debit'},{id:'asset-nature',reportType:'balanceSheet',normalBalance:'debit'}],
    postings:[
      ...Array.from({length:100},(_,i)=>({id:`cost-${i}`,organizationId:'org',accountId:'expense',entryDate:'2026-09-01',
        amount:0.01,side:'debit',currencyId:'DKK',isVoided:false})),
      {id:'sale',organizationId:'org',accountId:'revenue',entryDate:'2026-09-01',amount:1,side:'credit',currencyId:'DKK',isVoided:false},
      {id:'fx-cost',organizationId:'org',accountId:'expense',entryDate:'2026-09-02',amount:1,baseAmount:7,side:'debit',currencyId:'USD',isVoided:false},
      {id:'fx-sale',organizationId:'org',accountId:'revenue',entryDate:'2026-09-02',amount:7,side:'credit',currencyId:'DKK',isVoided:false},
      {id:'old-cost',organizationId:'org',accountId:'expense',entryDate:'2026-08-31',amount:2,side:'debit',currencyId:'DKK',isVoided:false},
      {id:'old-sale',organizationId:'org',accountId:'revenue',entryDate:'2026-08-31',amount:2,side:'credit',currencyId:'DKK',isVoided:false},
      {id:'void',organizationId:'org',accountId:'expense',entryDate:'2026-09-01',amount:999,side:'debit',currencyId:'DKK',isVoided:true},
      {id:'future',organizationId:'org',accountId:'expense',entryDate:'2026-10-01',amount:999,side:'debit',currencyId:'DKK',isVoided:false},
    ],
    bills:[{id:'bill-open',organizationId:'org',state:'approved',balance:12.34,currencyId:'USD',contactId:'vendor',entryDate:'2026-05-01'},
      {id:'bill-paid',organizationId:'org',state:'approved',balance:0,currencyId:'DKK'},
      {id:'bill-draft',organizationId:'org',state:'draft',balance:9,currencyId:'DKK'}],
    invoices:[{id:'invoice-open',organizationId:'org',state:'approved',balance:5.67,currencyId:'DKK',contactId:'customer'},
      {id:'invoice-paid',organizationId:'org',state:'approved',balance:0,currencyId:'USD'}],
  };
  const calls:string[]=[];
  const fetcher=async(input:string|URL|Request):Promise<Response>=>{
    const url=new URL(String(input));calls.push(`${url.pathname}${url.search}`);
    if(url.pathname.endsWith('/organization'))return Response.json({organization:{id:'org',baseCurrencyId:'DKK'}});
    const resource=url.pathname.split('/').at(-1)!;
    const rows=records[resource];if(!rows)return Response.json({message:'missing fixture'},{status:404});
    // Deliberately ignore every filter except pagination. Reports must enforce
    // date, void, state and paid criteria locally after full-page retrieval.
    const page=Number(url.searchParams.get('page')??1),pageSize=Number(url.searchParams.get('pageSize')??100);
    return Response.json({[resource]:rows.slice((page-1)*pageSize,page*pageSize),meta:{paging:{page,pageCount:Math.ceil(rows.length/pageSize)}}});
  };
  return {records,calls,reports:new Reports(new BillyClient('fixture-token','org',fetcher as typeof fetch,async()=>{}))};
}

test('trial balance fetches every page, locally enforces asOf and void state, and includes zero accounts on request',async()=>{
  const f=fixture();const report=await f.reports.trialBalance('2026-09-30',true);
  assert.equal(report.complete,true);assert.equal(report.sourcePostingCount,107);assert.equal(report.usedPostingCount,105);
  assert.deepEqual(report.totals,{debit:10,credit:10,difference:0});
  assert.equal(report.accounts.find(a=>a.accountId==='bank')?.netDebit,0);
  assert.ok(f.calls.some(path=>path.includes('/postings?')&&path.includes('page=2')));
  const scoped=await f.reports.trialBalance('2026-09-30',false,['expense']);
  assert.equal(scoped.scope,'selectedAccounts');assert.equal(scoped.totals.debit,10);assert.equal(scoped.totals.credit,0);
});

test('P&L classifies from live nature reportType or explicit IDs, with exact cent sums',async()=>{
  const f=fixture();const live=await f.reports.profitLoss('2026-09-01','2026-09-30',{});
  assert.equal(live.totals.revenue,8);assert.equal(live.totals.expenses,8);assert.equal(live.totals.profit,0);
  assert.equal(live.selectedPostingCount,103);assert.equal(live.expenses[0]?.postingCount,101);
  const explicit=await f.reports.profitLoss('2026-09-01','2026-09-30',{revenueAccountIds:['revenue'],expenseAccountIds:['expense']},true);
  assert.equal(explicit.totals.expenses,8);assert.equal(explicit.expenses[0]?.postings?.length,101);
  assert.equal(live.classification.reportType,'incomeStatement');
  await assert.rejects(f.reports.profitLoss('2026-09-01','2026-09-30',{reportType:'missing'}),/Unknown reportType/);
});

test('period expenses report only selected accounts and preserve FX base amounts',async()=>{
  const f=fixture();const report=await f.reports.periodExpenses('2026-09-01','2026-09-30','incomeStatement',['expense']);
  assert.equal(report.netExpense,8);assert.equal(report.selectedPostingCount,101);assert.equal(report.accounts[0]?.postingCount,101);
  assert.equal('postings' in report.accounts[0]!,false);
  await assert.rejects(f.reports.periodExpenses('2026-09-30','2026-09-01','incomeStatement',['expense']),/Start must precede/);
  await assert.rejects(f.reports.periodExpenses('2026-09-01','2026-09-30','incomeStatement',['bank']),/not an expense/);
});

test('outstanding uses current balances, excludes paid and drafts locally, and never mixes currencies',async()=>{
  const f=fixture();const report=await f.reports.outstanding();
  assert.equal(report.bills.length,1);assert.equal(report.invoices.length,1);
  assert.deepEqual(report.totals.payablesByCurrency,[{currencyId:'USD',balance:12.34,count:1}]);
  assert.deepEqual(report.totals.receivablesByCurrency,[{currencyId:'DKK',balance:5.67,count:1}]);
  assert.equal(report.sourceCounts.bills,3);assert.equal(report.complete,true);
});

test('reports fail explicitly on missing or malformed financial evidence',async()=>{
  const fx=fixture();delete fx.records.postings.find(p=>p.id==='fx-cost')!.baseAmount;
  await assert.rejects(fx.reports.trialBalance('2026-09-30'),/no baseAmount/);
  const amount=fixture();amount.records.postings.find(p=>p.id==='sale')!.amount=undefined;
  await assert.rejects(amount.reports.trialBalance('2026-09-30'),/amount must be/);
  const voided=fixture();delete voided.records.postings.find(p=>p.id==='sale')!.isVoided;
  await assert.rejects(voided.reports.trialBalance('2026-09-30'),/missing isVoided/);
  const missingBalance=fixture();delete missingBalance.records.bills.find(b=>b.id==='bill-open')!.balance;
  await assert.rejects(missingBalance.reports.outstanding(),/balance must be/);
  const wrongOrg=fixture();wrongOrg.records.postings.find(p=>p.id==='sale')!.organizationId='another';
  await assert.rejects(wrongOrg.reports.trialBalance('2026-09-30'),/Cross-organization/);
});
