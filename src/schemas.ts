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
  // subjectAmount is reviewed evidence. Billy derives it from cash, rate and fee.
  subjectAmount:positive.optional(),subjectCurrencyId:identifier.optional(),cashExchangeRate:exchangeRate.optional(),
  feeAmount:positive.optional(),feeAccountId:identifier.optional()})
  .superRefine((value,ctx)=>{
    const fx=[value.subjectCurrencyId,value.cashExchangeRate].some(v=>v!==undefined);
    if(fx&&value.subjectAmount===undefined)ctx.addIssue({code:'custom',path:['subjectAmount'],message:'Foreign-currency payment requires subjectAmount'});
    if(fx&&value.subjectCurrencyId===undefined)ctx.addIssue({code:'custom',path:['subjectCurrencyId'],message:'Foreign-currency payment requires subjectCurrencyId'});
    if(fx&&value.cashExchangeRate===undefined)ctx.addIssue({code:'custom',path:['cashExchangeRate'],message:'Foreign-currency payment requires cashExchangeRate'});
    if(Boolean(value.feeAmount)!==Boolean(value.feeAccountId))ctx.addIssue({code:'custom',path:['feeAccountId'],message:'Fee amount and expense account must be supplied together'});
    if(value.feeAmount!==undefined&&value.subjectAmount===undefined)ctx.addIssue({code:'custom',path:['subjectAmount'],message:'Payment with a fee requires explicit subjectAmount'});
  });
const salesLine=z.strictObject({productId:identifier,salesTaxRulesetId:identifier,expectedTaxRateId:identifier,quantity:z.number().finite().positive().max(1e8),unitPrice:money,description:z.string().trim().min(1).max(1000).optional()});
const salesTotals={expectedNetAmount:money,expectedTaxAmount:money,expectedTotalAmount:positive};
const salesInvoice=z.strictObject({kind:z.literal('create_sales_invoice'),contactId:identifier,entryDate:date,currencyId:identifier,taxMode:z.enum(['incl','excl']),
  lines:z.array(salesLine).min(1).max(100),...salesTotals,contactMessage:z.string().max(2000).optional()})
  .refine(v=>Math.round(v.expectedNetAmount*100)+Math.round(v.expectedTaxAmount*100)===Math.round(v.expectedTotalAmount*100),'Expected net plus VAT must equal gross');
const draftInvoice=z.strictObject({kind:z.literal('update_draft_invoice'),id:identifier,contactMessage:z.string().max(2000).optional(),
  taxMode:z.enum(['incl','excl']).optional(),paymentTermsDays:z.number().int().min(-365).max(3650).describe('Net days from invoice entryDate; sets paymentTermsMode to net and verifies the computed dueDate').optional(),...salesTotals})
  .refine(v=>v.contactMessage!==undefined||v.taxMode!==undefined||v.paymentTermsDays!==undefined,'Specify a documented mutable invoice field')
  .refine(v=>Math.round(v.expectedNetAmount*100)+Math.round(v.expectedTaxAmount*100)===Math.round(v.expectedTotalAmount*100),'Expected net plus VAT must equal gross');
const sendInvoice=z.strictObject({kind:z.literal('send_invoice'),id:identifier,contactPersonId:identifier,recipientEmail:z.email(),emailSubject:z.string().trim().min(1).max(500),emailBody:z.string().trim().min(1).max(10000)});
const customerCredit=z.strictObject({kind:z.literal('create_customer_credit_note'),originalInvoiceId:identifier,entryDate:date,
  lines:z.array(salesLine.extend({originalLineId:identifier})).min(1).max(100),...salesTotals})
  .refine(v=>Math.round(v.expectedNetAmount*100)+Math.round(v.expectedTaxAmount*100)===Math.round(v.expectedTotalAmount*100),'Expected net plus VAT must equal gross');
const supplierCredit=z.strictObject({kind:z.literal('create_supplier_credit_note'),receiptId,originalBillId:identifier,entryDate:date,
  lines:z.array(z.strictObject({originalLineId:identifier,accountId:identifier,taxRateId:identifier,description:z.string().min(1).max(1000),amount:positive})).min(1).max(100),
  ...salesTotals})
  .refine(v=>Math.round(v.expectedNetAmount*100)+Math.round(v.expectedTaxAmount*100)===Math.round(v.expectedTotalAmount*100),'Expected net plus VAT must equal gross');
const approval=z.strictObject({kind:z.literal('approve'),resource:z.enum(['bills','invoices','daybookTransactions']),id:identifier});
const upload=z.strictObject({kind:z.literal('upload_receipt'),receiptId});
const contact=z.strictObject({kind:z.literal('create_contact'),name:z.string().trim().min(1).max(200),countryId:z.string().regex(/^[A-Z]{2}$/),
  registrationNo:z.string().max(100).optional(),email:z.email().optional(),isSupplier:z.boolean(),isCustomer:z.boolean()});
const match=z.strictObject({kind:z.literal('reconcile'),bankLineId:identifier,subjectReference:reference});
export const operation=z.union([bill,journal,payment,approval,upload,contact,match,salesInvoice,draftInvoice,sendInvoice,customerCredit,supplierCredit]);
export type Operation=z.infer<typeof operation>;
export const receiptMetadata=z.strictObject({supplier:z.string().trim().min(1),supplierRegistrationNo:z.string().trim().min(1).optional(),supplierCountryId:z.string().regex(/^[A-Z]{2}$/).optional(),invoiceNumber:z.string().trim().min(1),invoiceDate:date,currencyId:identifier,
  documentType:z.enum(['invoice','creditNote']).optional(),creditedInvoiceNumber:z.string().trim().min(1).max(160).optional(),
  netAmount:money,vatAmount:money,totalAmount:positive})
  .refine(v=>!v.supplierRegistrationNo||Boolean(v.supplierCountryId),'Supplier registration number requires its country')
  .refine(v=>v.documentType==='creditNote'?Boolean(v.creditedInvoiceNumber):!v.creditedInvoiceNumber,'Supplier credit notes require the original invoice number')
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
