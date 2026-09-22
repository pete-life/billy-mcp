import {z} from 'zod';
export const identifier=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v,'Invalid calendar date');
export const money=z.number().finite().nonnegative().max(1e10).refine(v=>Math.abs(v*100-Math.round(v*100))<0.0001,'Amounts must have at most two decimals');
const positive=money.refine(v=>v>0,'Amount must be positive');
const exchangeRate=z.number().finite().positive().max(1e8);
export const side=z.enum(['debit','credit']);
export const reference=z.string().regex(/^(invoice|bill|posting|daybookTransaction|bankPayment):[A-Za-z0-9_-]{1,160}$/);
const receiptId=z.string().regex(/^[a-f0-9]{64}$/);
const bill=z.strictObject({kind:z.literal('create_bill'),receiptId,contactId:identifier,entryDate:date,currencyId:identifier,
  suppliersInvoiceNo:z.string().trim().min(1).max(160),taxMode:z.enum(['incl','excl']),
  lines:z.array(z.strictObject({accountId:identifier,taxRateId:identifier,description:z.string().min(1).max(1000),amount:positive})).min(1).max(100)});
const journal=z.strictObject({kind:z.literal('create_journal'),daybookId:identifier,entryDate:date,description:z.string().min(1).max(1000),
  receiptId:receiptId.optional(),bankLineId:identifier.optional(),noReceiptReason:z.string().min(10).max(1000).optional(),
  lines:z.array(z.strictObject({accountId:identifier,text:z.string().min(1).max(500),amount:positive,side,currencyId:identifier,taxRateId:identifier.optional()})).min(2).max(100)})
  .refine(v=>Boolean(v.receiptId)!==Boolean(v.noReceiptReason),'Provide either a receipt or an explicit reason why none is needed')
  .refine(v=>!v.noReceiptReason||Boolean(v.bankLineId),'A journal without a receipt must identify its bank line')
  .refine(v=>new Set(v.lines.map(l=>l.currencyId)).size===1,'Journal lines must use one currency')
  .refine(v=>v.lines.reduce((sum,l)=>sum+(l.side==='debit'?1:-1)*Math.round(l.amount*100),0)===0,'Journal debits and credits must balance');
const payment=z.strictObject({kind:z.literal('create_payment'),entryDate:date,cashAmount:positive,cashSide:side,cashAccountId:identifier,bankLineId:identifier,
  subjectReference:z.string().regex(/^(bill|invoice):[A-Za-z0-9_-]{1,160}$/),
  // Billy derives the subject amount from cashAmount/cashExchangeRate. These
  // fields are caller evidence for the narrow foreign-currency full-settlement
  // path; they are not copied blindly into the bankPayment payload.
  subjectAmount:positive.optional(),subjectCurrencyId:identifier.optional(),cashExchangeRate:exchangeRate.optional()})
  .superRefine((value,ctx)=>{
    const supplied=[value.subjectAmount,value.subjectCurrencyId,value.cashExchangeRate].some(v=>v!==undefined);
    if(!supplied)return;
    if(value.subjectAmount===undefined)ctx.addIssue({code:'custom',path:['subjectAmount'],message:'Foreign-currency payment requires subjectAmount'});
    if(value.subjectCurrencyId===undefined)ctx.addIssue({code:'custom',path:['subjectCurrencyId'],message:'Foreign-currency payment requires subjectCurrencyId'});
    if(value.cashExchangeRate===undefined)ctx.addIssue({code:'custom',path:['cashExchangeRate'],message:'Foreign-currency payment requires cashExchangeRate'});
  });
const approval=z.strictObject({kind:z.literal('approve'),resource:z.enum(['bills','invoices','daybookTransactions']),id:identifier});
const upload=z.strictObject({kind:z.literal('upload_receipt'),receiptId});
const contact=z.strictObject({kind:z.literal('create_contact'),name:z.string().trim().min(1).max(200),countryId:z.string().regex(/^[A-Z]{2}$/),
  registrationNo:z.string().max(100).optional(),email:z.email().optional(),isSupplier:z.boolean(),isCustomer:z.boolean()});
const match=z.strictObject({kind:z.literal('reconcile'),bankLineId:identifier,subjectReference:reference});
export const operation=z.union([bill,journal,payment,approval,upload,contact,match]);
export type Operation=z.infer<typeof operation>;
export const receiptMetadata=z.strictObject({supplier:z.string().trim().min(1),supplierRegistrationNo:z.string().trim().min(1).optional(),supplierCountryId:z.string().regex(/^[A-Z]{2}$/).optional(),invoiceNumber:z.string().trim().min(1),invoiceDate:date,currencyId:identifier,
  netAmount:money,vatAmount:money,totalAmount:positive})
  .refine(v=>!v.supplierRegistrationNo||Boolean(v.supplierCountryId),'Supplier registration number requires its country')
  .refine(v=>Math.round(v.netAmount*100)+Math.round(v.vatAmount*100)===Math.round(v.totalAmount*100),'Net plus VAT must equal gross');
export const source=z.strictObject({kind:z.enum(['gmail','drive','vendor_portal','local']),reference:z.string().min(1).max(1000),
  vendorId:identifier.optional(),retrievedAt:z.iso.datetime().optional()});
export function sanitizeSource(value:z.infer<typeof source>) {
  if(value.kind==='vendor_portal') {
    const url=new URL(value.reference);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Vendor source must be an HTTPS URL without credentials');
    // Store only the origin: signed path segments can contain bearer credentials too.
    return {...value,reference:url.origin};
  }
  if(value.kind==='gmail'||value.kind==='drive'){
    if(!/^[A-Za-z0-9_:\/.-]{1,500}$/.test(value.reference)||value.reference.includes('://'))throw new Error('Use stable message/file/attachment IDs, not download URLs');
  }
  return value;
}
