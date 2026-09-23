import {BillyClient,type RecordData,type Resource} from './client.js';

const datePattern=/^\d{4}-\d{2}-\d{2}$/;
function validDate(value:string){if(!datePattern.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new Error('Invalid calendar date');}
function period(start:string,end:string){validDate(start);validDate(end);if(start>end)throw new Error('Start must precede end');}
function idOf(record:RecordData,key:string):string|undefined{return typeof record[`${key}Id`]==='string'?record[`${key}Id`]:typeof record[key]?.id==='string'?record[key].id:undefined;}
function requiredId(record:RecordData,key:string,kind:string){const value=idOf(record,key);if(!value)throw new Error(`${kind} ${record.id??'<unknown>'} is missing ${key}Id`);return value;}
function cents(value:unknown,label:string):number{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||Math.abs(value*100-Math.round(value*100))>0.0001)throw new Error(`${label} must be a nonnegative amount with at most two decimals`);
  return Math.round(value*100);
}
function signedCents(value:unknown,label:string):number{
  if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value*100-Math.round(value*100))>0.0001)throw new Error(`${label} must be an amount with at most two decimals`);
  return Math.round(value*100);
}
function money(value:number){return value/100;}
function postingSide(record:RecordData){if(record.side!=='debit'&&record.side!=='credit')throw new Error(`Posting ${record.id} has an invalid side`);return record.side as 'debit'|'credit';}
function baseCurrency(org:RecordData){return requiredId(org,'baseCurrency','Organization');}
function postingBaseCents(p:RecordData,baseCurrencyId:string){
  const currencyId=requiredId(p,'currency','Posting');
  const own=cents(p.amount,`Posting ${p.id} amount`);
  if(p.baseAmount!==undefined){
    const base=cents(p.baseAmount,`Posting ${p.id} baseAmount`);
    if(currencyId===baseCurrencyId&&base!==own)throw new Error(`Posting ${p.id} baseAmount differs from amount in base currency`);
    return base;
  }
  if(currencyId!==baseCurrencyId)throw new Error(`Posting ${p.id} is in ${currencyId}, but has no baseAmount; a base-currency report cannot convert it safely`);
  return own;
}
type Line={id:string;entryDate:string;accountId:string;transactionId?:string;currencyId:string;amount:number;baseAmount:number;side:'debit'|'credit'};
function summarize(postings:RecordData[],baseCurrencyId:string):Line[]{
  return postings.map(p=>{
    if(typeof p.id!=='string'||!p.id)throw new Error('Posting is missing id');
    if(typeof p.entryDate!=='string'||!datePattern.test(p.entryDate))throw new Error(`Posting ${p.id} is missing a valid entryDate`);
    const accountId=requiredId(p,'account','Posting'),currencyId=requiredId(p,'currency','Posting');
    return {id:p.id,entryDate:p.entryDate,accountId,transactionId:idOf(p,'transaction'),currencyId,
      amount:money(cents(p.amount,`Posting ${p.id} amount`)),baseAmount:money(postingBaseCents(p,baseCurrencyId)),side:postingSide(p)};
  });
}
function netCents(line:Line){return Math.round(line.baseAmount*100)*(line.side==='debit'?1:-1);}
function uniqueIds(ids:string[]){if(new Set(ids).size!==ids.length)throw new Error('Duplicate account IDs');return new Set(ids);}

export class Reports {
  constructor(private client:BillyClient){}
  private async ledger(maxEntryDate:string,minEntryDate?:string){
    const organization=await this.client.verifyOrganization(),baseCurrencyId=baseCurrency(organization);
    const [accounts,postings]=await Promise.all([
      this.client.list('accounts'),this.client.list('postings',{...(minEntryDate?{minEntryDate}:{}),maxEntryDate}),
    ]);
    const accountById=new Map(accounts.map(a=>[a.id,a]));
    if(accountById.size!==accounts.length)throw new Error('Duplicate accounts in complete chart');
    const filtered=postings.filter(p=>{
      if(typeof p.entryDate!=='string'||!datePattern.test(p.entryDate))throw new Error(`Posting ${p.id} is missing a valid entryDate`);
      if(typeof p.isVoided!=='boolean')throw new Error(`Posting ${p.id} is missing isVoided`);
      return !p.isVoided&&p.entryDate<=maxEntryDate&&(!minEntryDate||p.entryDate>=minEntryDate);
    });
    const lines=summarize(filtered,baseCurrencyId);
    for(const p of lines)if(!accountById.has(p.accountId))throw new Error(`Posting ${p.id} refers to unknown account ${p.accountId}`);
    return {baseCurrencyId,accounts,accountById,lines,sourcePostingCount:postings.length};
  }
  async trialBalance(asOf:string,includeZero=false,accountIds?:string[]){
    validDate(asOf);const ledger=await this.ledger(asOf);
    const selected=accountIds?uniqueIds(accountIds):undefined;
    if(selected)for(const id of selected)if(!ledger.accountById.has(id))throw new Error(`Unknown account ${id}`);
    const sums=new Map<string,{debit:number;credit:number;postingCount:number}>();
    for(const line of ledger.lines){
      if(selected&&!selected.has(line.accountId))continue;
      const value=sums.get(line.accountId)??{debit:0,credit:0,postingCount:0};
      value[line.side]+=Math.round(line.baseAmount*100);value.postingCount++;sums.set(line.accountId,value);
    }
    const accounts=ledger.accounts.filter(a=>!selected||selected.has(a.id)).map(a=>{
      const x=sums.get(a.id)??{debit:0,credit:0,postingCount:0},net=x.debit-x.credit;
      return {accountId:a.id,accountNo:a.accountNo,name:a.name,groupId:idOf(a,'group'),natureId:idOf(a,'nature'),
        debit:money(Math.max(net,0)),credit:money(Math.max(-net,0)),netDebit:money(net),postingCount:x.postingCount};
    }).filter(row=>includeZero||row.netDebit!==0);
    const debitCents=accounts.reduce((n,a)=>n+Math.round(a.debit*100),0),creditCents=accounts.reduce((n,a)=>n+Math.round(a.credit*100),0);
    return {asOf,baseCurrencyId:ledger.baseCurrencyId,scope:selected?'selectedAccounts':'allAccounts',includeZero,
      accounts,totals:{debit:money(debitCents),credit:money(creditCents),difference:money(debitCents-creditCents)},
      sourcePostingCount:ledger.sourcePostingCount,usedPostingCount:ledger.lines.filter(p=>!selected||selected.has(p.accountId)).length,
      complete:true,basis:'Current non-voided postings with entryDate through asOf; current void state, not a historical snapshot.'};
  }
  private async classifiedAccounts(ledger:Awaited<ReturnType<Reports['ledger']>>,reportType:string){
    const [groups,natures]=await Promise.all([this.client.list('accountGroups' as Resource),this.client.list('accountNatures' as Resource)]);
    const byGroup=new Map(groups.map(g=>[g.id,g])),byNature=new Map(natures.map(n=>[n.id,n]));
    if(byGroup.size!==groups.length||byNature.size!==natures.length)throw new Error('Duplicate account classification records');
    if(!natures.some(n=>n.reportType===reportType))throw new Error(`Unknown reportType ${reportType}; inspect billy_list accountNatures for this company`);
    const revenue=new Set<string>(),expense=new Set<string>();
    for(const account of ledger.accounts){
      const groupId=requiredId(account,'group','Account'),group=byGroup.get(groupId);
      if(!group)throw new Error(`Account ${account.id} refers to unknown group ${groupId}`);
      const natureId=requiredId(group,'nature','Account group'),nature=byNature.get(natureId);
      if(!nature)throw new Error(`Account group ${groupId} refers to unknown nature ${natureId}`);
      if(nature.reportType!==reportType)continue;
      if(nature.normalBalance==='credit')revenue.add(account.id);
      else if(nature.normalBalance==='debit')expense.add(account.id);
      else throw new Error(`Nature ${natureId} has unsupported normalBalance`);
    }
    if(!revenue.size&&!expense.size)throw new Error(`No accounts match reportType ${reportType}`);
    return {revenue,expense};
  }
  async profitLoss(start:string,end:string,options:{reportType?:string;revenueAccountIds?:string[];expenseAccountIds?:string[]},verbose=false){
    period(start,end);const ledger=await this.ledger(end,start);
    const explicit=options.revenueAccountIds!==undefined||options.expenseAccountIds!==undefined;
    if(options.reportType&&explicit)throw new Error('Provide either a live reportType or explicit revenueAccountIds and expenseAccountIds');
    if(explicit&&(!options.revenueAccountIds||!options.expenseAccountIds))throw new Error('Explicit P&L needs both revenueAccountIds and expenseAccountIds');
    const reportType=options.reportType??'incomeStatement';
    const selected=explicit?{revenue:uniqueIds(options.revenueAccountIds!),expense:uniqueIds(options.expenseAccountIds!)}:await this.classifiedAccounts(ledger,reportType);
    if(!selected.revenue.size&&!selected.expense.size)throw new Error('Select at least one P&L account');
    for(const id of selected.revenue)if(!ledger.accountById.has(id))throw new Error(`Unknown account ${id}`);
    for(const id of selected.expense)if(!ledger.accountById.has(id))throw new Error(`Unknown account ${id}`);
    for(const id of selected.revenue)if(selected.expense.has(id))throw new Error(`Account ${id} is both revenue and expense`);
    const rows=(ids:Set<string>,sign:number)=>[...ids].map(id=>{
      const account=ledger.accountById.get(id)!,postings=ledger.lines.filter(p=>p.accountId===id),sum=postings.reduce((n,p)=>n+netCents(p)*sign,0);
      return {accountId:id,accountNo:account.accountNo,name:account.name,amount:money(sum),postingCount:postings.length,
        ...(verbose?{postings}:{} )};
    });
    const revenues=rows(selected.revenue,-1),expenses=rows(selected.expense,1);
    const revenueCents=revenues.reduce((n,r)=>n+Math.round(r.amount*100),0),expenseCents=expenses.reduce((n,r)=>n+Math.round(r.amount*100),0);
    return {period:{start,end},baseCurrencyId:ledger.baseCurrencyId,classification:explicit?{source:'explicitAccountIds'}:{source:'accountNature.reportType',reportType},
      revenues,expenses,totals:{revenue:money(revenueCents),expenses:money(expenseCents),profit:money(revenueCents-expenseCents)},
      sourcePostingCount:ledger.sourcePostingCount,selectedPostingCount:ledger.lines.filter(p=>selected.revenue.has(p.accountId)||selected.expense.has(p.accountId)).length,
      completeForSelectedAccounts:true,basis:'Current non-voided postings within inclusive entryDate period. Explicit IDs cover only selected accounts.'};
  }
  async periodExpenses(start:string,end:string,reportType:string,accountIds?:string[],verbose=false){
    period(start,end);const ledger=await this.ledger(end,start),classified=await this.classifiedAccounts(ledger,reportType);
    const selected=accountIds?uniqueIds(accountIds):classified.expense;
    if(!selected.size)throw new Error('No expense accounts match this reportType');
    for(const id of selected)if(!classified.expense.has(id))throw new Error(`Account ${id} is not an expense account for reportType ${reportType}`);
    const accounts=[...selected].map(id=>{
      const account=ledger.accountById.get(id)!,postings=ledger.lines.filter(p=>p.accountId===id);
      return {accountId:id,accountNo:account.accountNo,name:account.name,netExpense:money(postings.reduce((n,p)=>n+netCents(p),0)),postingCount:postings.length,
        ...(verbose?{postings}:{} )};
    });
    return {period:{start,end},baseCurrencyId:ledger.baseCurrencyId,classification:{source:'accountNature.reportType',reportType,scope:accountIds?'selectedExpenseAccounts':'allExpenseAccounts'},accounts,
      netExpense:money(accounts.reduce((n,a)=>n+Math.round(a.netExpense*100),0)),sourcePostingCount:ledger.sourcePostingCount,
      selectedPostingCount:accounts.reduce((n,a)=>n+a.postingCount,0),completeForSelectedAccounts:true,
      basis:'Current non-voided postings within inclusive entryDate period, on debit-normal accounts in the selected reportType.'};
  }
  async outstanding(){
    await this.client.verifyOrganization();
    const [bills,invoices]=await Promise.all([this.client.list('bills'),this.client.list('invoices')]);
    const collect=(records:RecordData[],kind:'bill'|'invoice')=>records.filter(r=>{
      if(typeof r.state!=='string')throw new Error(`${kind} ${r.id} is missing state`);
      return r.state==='approved';
    }).map(r=>{
      if(typeof r.id!=='string'||!r.id)throw new Error(`${kind} is missing id`);
      const balance=signedCents(r.balance,`${kind} ${r.id} balance`),currencyId=requiredId(r,'currency',kind);
      if(typeof r.type!=='string'||!r.type)throw new Error(`${kind} ${r.id} is missing document type`);
      return {id:r.id,type:r.type,contactId:idOf(r,'contact'),entryDate:r.entryDate,dueDate:r.dueDate,currencyId,
        balance:money(balance),state:r.state,...(kind==='bill'?{suppliersInvoiceNo:r.suppliersInvoiceNo}:{invoiceNo:r.invoiceNo})};
    }).filter(r=>r.balance!==0);
    const billRows=collect(bills,'bill'),invoiceRows=collect(invoices,'invoice');
    const openBills=billRows.filter(r=>r.type!=='creditNote'),openInvoices=invoiceRows.filter(r=>r.type!=='creditNote');
    const creditNotes={bills:billRows.filter(r=>r.type==='creditNote'),invoices:invoiceRows.filter(r=>r.type==='creditNote')};
    const totals=(records:typeof openBills)=>{
      const grouped=new Map<string,{balance:number;count:number}>();
      for(const r of records){const value=grouped.get(r.currencyId)??{balance:0,count:0};value.balance+=Math.round(r.balance*100);value.count++;grouped.set(r.currencyId,value);}
      return [...grouped].map(([currencyId,value])=>({currencyId,balance:money(value.balance),count:value.count}));
    };
    return {observedAt:new Date().toISOString(),bills:openBills,invoices:openInvoices,creditNotes,
      totals:{payablesByCurrency:totals(openBills),receivablesByCurrency:totals(openInvoices)},
      sourceCounts:{bills:bills.length,invoices:invoices.length},complete:true,
      basis:'Current approved document balances only. Credit notes are shown separately and excluded from payable/receivable totals; their balance polarity is not inferred. This is not a historical as-of balance; currencies are not mixed or converted.'};
  }
}
