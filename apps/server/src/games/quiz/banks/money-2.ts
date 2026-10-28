/** Money and payments, part 2: cards, payment rails, banking, fraud and compliance. */
export default `
How many digits does a typical Visa or Mastercard card number have? | 16 | 12 | 14 | 19
What is the first digit of a Visa card number? | 4 | 3 | 5 | 6
Mastercard numbers usually begin with which digits? | 51–55 or 2221–2720 | 4 only | 34 or 37 | 6011
American Express card numbers start with which digits? | 34 or 37 | 4 | 51 to 55 | 6011
How many digits does an American Express card number have? | 15 | 16 | 14 | 13
What is the first digit of a card number called? | The Major Industry Identifier | The check digit | The PIN digit | The CVV
What are the first six to eight digits of a card number called? | The BIN or IIN | The PAN | The CVV | The PIN
What does BIN stand for in card payments? | Bank Identification Number | Basic Issuer Number | Bank Index Node | Billing Identity Number
What does PAN stand for on a card? | Primary Account Number | Personal Authorisation Number | Payment Access Number | Public Account Name
Which algorithm checks that a card number is valid? | The Luhn algorithm | RSA | SHA-256 | Dijkstra's algorithm
What does CVV stand for? | Card Verification Value | Card Validation Vector | Credit Verification Volume | Customer Value Verification
How many digits is the CVV on most Visa and Mastercard cards? | 3 | 2 | 4 | 6
How many digits is the security code on the front of an American Express card? | 4 | 3 | 5 | 6
What does PIN stand for? | Personal Identification Number | Private Internet Number | Payment Index Number | Primary Identity Note
What does EMV stand for in chip cards? | Europay, Mastercard and Visa | Electronic Money Verification | Encrypted Merchant Value | Euro Mastercard Visa
What is the name of the local card scheme of Nigeria? | Verve | RuPay | Elo | Mir
Which company runs the Verve card scheme? | Interswitch | NIBSS | Paystack | Flutterwave
What is India's domestic card scheme called? | RuPay | Verve | Elo | Mir
What is Brazil's domestic card scheme called? | Elo | RuPay | Mir | Verve
What is Russia's domestic card scheme called? | Mir | RuPay | Elo | Troy
What is China's largest card scheme? | UnionPay | Alipay | JCB | WeChat Pay
Which card scheme comes from Japan? | JCB | UnionPay | Discover | Diners Club
Which was the first modern charge card, launched in 1950? | Diners Club | American Express | Visa | Mastercard
What was Visa originally called? | BankAmericard | Master Charge | Visa International only | CardOne
What was Mastercard originally called? | Master Charge | BankAmericard | Interbank Card | ChargeAll
What is the difference between a debit card and a credit card? | Debit uses your own money; credit borrows from the issuer | There is none | Debit cards can't be used online | Credit cards have no limit
What is a prepaid card? | A card loaded with money in advance | A card with unlimited credit | A loyalty card | A card that pays you interest
What is a virtual card? | A card number that exists only digitally | A card used only in games | A card with no number | A card for kids
What is the "issuer" in card payments? | The bank that gives the card to the customer | The merchant's bank | The card network | The shop
What is the "acquirer" in card payments? | The bank that processes payments for the merchant | The cardholder's bank | The card network | The customer
What does a card network like Visa or Mastercard do? | Connects issuers and acquirers and sets the rules | Lends money to cardholders | Prints all cards | Owns the shops
What is "interchange"? | A fee the acquirer pays to the issuer per card payment | A currency swap | A loan transfer | A tax on cards
What is the "MDR" a merchant pays? | The merchant discount rate, the fee for accepting cards | The monthly deposit requirement | The minimum daily revenue | The merchant default risk
What is a "payment gateway"? | A service that securely passes online payments to processors | A physical bank door | A type of ATM | A shop's cash register
What is a "payment processor"? | A company that handles the transaction between merchant and banks | A person who counts cash | A card printer | A tax authority
What is a "PSP"? | A payment service provider | A personal savings plan | A public sector payment | A primary settlement point
What is a "merchant" in payments? | A business that accepts payments | A bank teller | A card network | A regulator
What is "authorisation" in card payments? | The issuer approving a transaction | The money arriving in the merchant's account | A refund | A chargeback
What is "settlement" in payments? | The actual movement of funds between banks | Approving a card | Opening an account | Printing a receipt
What is "clearing" in payments? | Exchanging and reconciling transaction details before settlement | Withdrawing cash | Closing an account | Deleting card data
What does "T+1" mean for settlement? | Funds settle one business day after the transaction | Funds settle instantly | Funds settle one hour later | One transaction per day
What is a "pre-authorisation"? | A temporary hold on funds before the final charge | A refund | A credit limit increase | A declined payment
Hotels and car rentals often place what on your card? | A pre-authorisation hold | A chargeback | A loan | A direct debit
What is a "refund"? | Money returned to the customer by the merchant | A payment reversal forced by the bank | A fee | A loan
What is a "reversal" or "void"? | Cancelling a transaction before it settles | A refund after settlement | A chargeback | A deposit
What is "friendly fraud"? | A customer disputing a genuine purchase | Fraud between friends | A small fraud | A bank error
What is "card-not-present" (CNP) fraud? | Fraud using card details without the physical card, like online | Stealing a physical card | ATM skimming | Cheque fraud
What is "skimming"? | Copying card data with a hidden device | Spending little money | Checking a balance | Paying in instalments
What is "phishing"? | Tricking people into giving away details through fake messages | Hacking a bank's servers | Copying cards at ATMs | Insider fraud
What is "smishing"? | Phishing by SMS | Phishing by email | Phishing by phone call | Phishing by post
What is "vishing"? | Phishing by voice call | Phishing by SMS | Phishing by video | Phishing by email
What is "SIM swap" fraud? | A fraudster moving your number to their SIM to get your codes | Swapping phones with a friend | A network upgrade | Roaming abroad
What is "account takeover" fraud? | A criminal gaining control of a real customer's account | Opening a new account | Merging two accounts | Closing an account
What is "money mule" activity? | Moving criminal money through your own account | Carrying cash on a donkey | Saving in a piggy bank | Lending to friends
What is "3-D Secure"? | An extra authentication step for online card payments | A 3D printer payment | A type of card chip | A bank vault
What is the consumer name for Visa's 3-D Secure? | Visa Secure (formerly Verified by Visa) | Visa Shield | Visa Lock | Visa Guard
What is "two-factor authentication"? | Proving who you are with two different kinds of evidence | Two passwords | Logging in twice | Two people approving
What is an "OTP"? | A one-time password | An online transfer protocol | An open trading platform | An overdraft trigger point
What is "tokenisation" in payments? | Replacing card numbers with a substitute token | Paying with tokens at an arcade | Issuing crypto | Splitting payments
What does PCI stand for in PCI DSS? | Payment Card Industry | Personal Credit Information | Public Card Infrastructure | Private Customer Identity
What is "chargeback fraud" also called? | Friendly fraud | Skimming | Phishing | Carding
What is a "chargeback ratio"? | Chargebacks as a share of transactions | The fee per chargeback | Refunds per day | The bank's profit margin
What is the "dispute" process in card payments? | How a cardholder challenges a charge | How banks set interest | How merchants open accounts | How cards are printed
What does "AML" stand for? | Anti-Money Laundering | Automated Money Lending | Account Management Limit | Asset Market Liquidity
What does "CFT" stand for alongside AML? | Countering the Financing of Terrorism | Customer Fund Transfer | Central Funds Treasury | Cash Flow Tracking
What are the three classic stages of money laundering? | Placement, layering and integration | Saving, spending and investing | Earning, hiding and spending | Deposit, withdraw and transfer
What is a "PEP" in compliance? | A politically exposed person | A personal equity plan | A payment exception process | A primary exchange partner
What is an "SAR" or "STR"? | A suspicious activity or transaction report | A savings account rate | A standard account record | A secure authentication request
What is "sanctions screening"? | Checking customers against lists of banned people and entities | Checking credit scores | Checking ID photos | Screening films
Which US office publishes a major sanctions list? | OFAC | The SEC | The FDIC | The IRS
Which international body sets AML standards and keeps a "grey list"? | The Financial Action Task Force (FATF) | The IMF | The World Bank | The WTO
What is "KYB"? | Know Your Business | Keep Your Balance | Know Your Bank | Key Year Budget
What is "CDD" in compliance? | Customer due diligence | Card data destruction | Central debit desk | Credit default detection
What is "EDD"? | Enhanced due diligence | Electronic debit date | Easy deposit documents | Early default detection
What is "open banking"? | Letting customers share bank data with approved third parties through APIs | Banks opening on Sundays | Free bank accounts | Banks without doors
Which EU directive pushed open banking in Europe? | PSD2 | GDPR | MiFID II | Basel III
What does "SCA" stand for under PSD2? | Strong Customer Authentication | Secure Card Access | Standard Credit Agreement | Single Currency Area
What is an "IBAN"? | An International Bank Account Number | An Internet Banking Access Number | An Interbank Network | An International Bank Approval Note
How many characters long can an IBAN be, at most? | 34 | 16 | 22 | 40
What do the first two letters of an IBAN show? | The country code | The bank's initials | The currency | The account type
What is a SWIFT or BIC code? | A code that identifies a bank internationally | A card security code | A country's tax ID | A currency code
How many characters is a SWIFT/BIC code? | 8 or 11 | 6 | 10 | 16
What does SWIFT stand for? | Society for Worldwide Interbank Financial Telecommunication | Secure Worldwide International Funds Transfer | Standard Wire for International Fast Transfers | Swiss World Interbank Financial Trust
In which country is SWIFT headquartered? | Belgium | Switzerland | United States | United Kingdom
What is a "correspondent bank"? | A bank that handles payments on behalf of another bank abroad | A bank that writes letters | A central bank | A savings club
What is a "wire transfer"? | An electronic transfer of money between banks | A transfer by post | A cash delivery | A cheque
What is "ACH" in the US? | The Automated Clearing House network | A credit card brand | A type of ATM | A bank regulator
What is "RTGS"? | Real-Time Gross Settlement | Rapid Transfer Global System | Regional Trade Guarantee Scheme | Retail Transaction Gateway Service
What does "gross settlement" mean? | Each payment settles individually, not netted | Payments are combined and netted | Payments include fees | Payments are taxed
What is the UK's instant payments system called? | Faster Payments | BACS | Link | SEPA Instant
What is the UK's high-value same-day payment system called? | CHAPS | BACS | Faster Payments | Link
What is SEPA in Europe? | The Single Euro Payments Area | The Secure European Payment Authority | The Standard Euro Pricing Agreement | The Shared ECB Payment Account
What is India's instant mobile payment system called? | UPI | RTGS | NACH | Paytm
Which country's UPI processes billions of payments each month? | India | Brazil | Indonesia | Kenya
What is Brazil's instant payment system called? | Pix | UPI | SPEI | FedNow
What is Mexico's real-time payment system called? | SPEI | Pix | UPI | FedNow
What is the US Federal Reserve's instant payment service, launched in 2023? | FedNow | Zelle | ACH Direct | Fedwire Instant
What is Zelle? | A US bank-to-bank instant payment service | A card network | A crypto exchange | A central bank
What is Nigeria's instant interbank transfer service called? | NIP (NIBSS Instant Payment) | NEFT | RTGS | UPI
What does NIBSS stand for? | Nigeria Inter-Bank Settlement System | National Interbank Banking Standard System | Nigerian Instant Banking Security Service | National Investment and Banking Settlement Scheme
What is the BVN in Nigeria? | Bank Verification Number | Basic Value Number | Bank Vault Number | Business Validation Note
How many digits is a Nigerian BVN? | 11 | 10 | 12 | 16
What is NUBAN in Nigeria? | The Nigerian Uniform Bank Account Number format | A national ID | A bank in Abuja | A payment app
How many digits is a NUBAN account number? | 10 | 8 | 11 | 12
What is the NIN in Nigeria? | National Identification Number | National Interbank Number | Nigeria Investment Note | National Insurance Number
Which agency issues Nigeria's NIN? | NIMC | CBN | NIBSS | NCC
How many digits is a Nigerian NIN? | 11 | 10 | 12 | 9
What is USSD banking? | Banking by dialling short codes like *737# | Banking by email | Banking by post | Banking in branches only
Why is USSD banking popular in Nigeria? | It works on basic phones without internet | It's always free | It uses no network | It needs a smartphone
What is "POS" banking in Nigeria often used for? | Cash withdrawals and transfers through agents | Buying shares | Paying taxes only | Opening offshore accounts
What is "agency banking"? | Using local shops as bank agents for basic services | Banking for estate agents | Banking only through apps | Private banking for the rich
What is "mobile money"? | Money stored and sent using a mobile phone account | Money you can only spend on phones | Coins for phone booths | Airtime only
Which Kenyan mobile money service changed how millions pay? | M-Pesa | MTN MoMo | Airtel Money | Paga
What is MTN's mobile money service called? | MoMo | M-Pesa | OPay | Paga
Which Nigerian fintech started as a mobile money and agent network in 2009? | Paga | Paystack | Kuda | Carbon
Which Nigerian company is known for POS terminals and banking for small businesses? | Moniepoint | Paystack | Piggyvest | Cowrywise
What is a "digital bank" or "neobank"? | A bank that operates mainly through apps | A bank for robots | A central bank | A bank only for crypto
Which Nigerian neobank calls itself "the money app for Africans"? | Kuda | Opay | Palmpay | VBank
What is "BNPL"? | Buy now, pay later | Bank now, pay later | Bill notice payment letter | Basic national payment line
What is a "standing order"? | A fixed regular payment you set up from your account | A merchant pulling money when they choose | A queue at the bank | A cheque
What is a "direct debit"? | Letting a company pull payments from your account | A fixed payment you push | A cash deposit | A refund
What is a "recurring payment"? | A payment that repeats on a schedule | A payment that fails | A one-off gift | A refund
What is a "subscription" business model? | Customers pay regularly for ongoing access | Customers pay once forever | Customers pay nothing | Customers are paid
What is a "cheque"? | A written order telling a bank to pay someone | A receipt | A bank statement | A loan agreement
What is a cheque that bounces? | One refused because there isn't enough money | One that is cashed twice | One with a typo | One paid in coins
What is a "crossed cheque"? | One that must be paid into a bank account | One that has been cancelled | One that has expired | One signed twice
What does "post-dated" mean on a cheque? | It's dated for a future day | It's sent by post | It's expired | It's for the post office
What is an "overdraft"? | Borrowing by spending more than is in your account | A savings bonus | A type of cheque | A fee for deposits
What does "insufficient funds" mean? | There isn't enough money in the account | The bank is closed | The card is fake | The amount is too small
What is "float" in payments? | Money in transit that has left one account but not reached another | A floating exchange rate | A parade | A stock
What is an "escrow" account? | One where a third party holds money until conditions are met | A secret account | A joint savings account | A business current account
What is a "merchant account"? | An account that lets a business receive card payments | A savings account for merchants only | A loan | A tax account
What is "reconciliation"? | Matching your records with bank or processor records | Making up after an argument | Closing an account | Paying a fine
What is a "payout"? | Money sent out to a recipient, like a merchant or seller | Money paid in | A fee | A refund request
What is a "payment link"? | A URL that lets someone pay you online | A chain of banks | A loan agreement | A card network
What is "split payment"? | Dividing one payment among several recipients | Paying with two cards only | A refund in halves | A failed payment
What is "multi-currency pricing"? | Showing prices in the customer's currency | Charging different taxes | Paying in coins | Using two banks
What is "dynamic currency conversion"? | Letting a card holder pay in their home currency at the terminal | A floating exchange rate | A currency crisis | A crypto swap
What is "cross-border" payment? | A payment between parties in different countries | A payment at a border post | A cash payment | A payment between two banks in one city
What is "FX markup"? | Extra margin added to an exchange rate | A tax on imports | A discount | A card fee for ATMs
What is a "payment rail"? | The infrastructure that moves money between parties | A railway ticket | A card reader | A bank counter
What is "real-time payment"? | A payment that settles within seconds | A payment made at noon | A payment once a week | A cash payment
What is a "QR code payment"? | Paying by scanning a code with your phone | Paying by cheque | Paying by voice | Paying with coins
Which Chinese apps dominate QR code payments? | Alipay and WeChat Pay | UnionPay and JCB | PayPal and Venmo | Paytm and PhonePe
What is "contactless" payment? | Tapping a card or phone on a terminal | Paying by post | Paying without a card number | Paying in cash
Which technology powers contactless payments? | NFC (near-field communication) | Bluetooth | Wi-Fi | Infrared
What is Apple's tap-to-pay service called? | Apple Pay | iPay | Apple Tap | Apple Money
What is Google's tap-to-pay service called? | Google Pay | Android Cash | G-Money | Google Tap
Which company owns Venmo? | PayPal | Square | Stripe | Visa
Which company was co-founded by Peter Thiel and became part of eBay in 2002? | PayPal | Stripe | Square | Venmo
Which company did Elon Musk co-found that merged with Confinity to form PayPal? | X.com | Zip2 | SpaceX | Tesla
Which brothers founded Stripe? | Patrick and John Collison | Max and Peter Levchin | Jack and Jim Dorsey | Paul and Peter Thiel
From which country are Stripe's founders? | Ireland | United States | United Kingdom | Canada
Which company makes the Square card reader? | Block | Stripe | PayPal | Visa
What was Block, the company behind Square and Cash App, formerly called? | Square | Cash Inc. | Bitcoin Corp | Twitter Payments
Who co-founded Square? | Jack Dorsey and Jim McKelvey | Patrick Collison and John Collison | Peter Thiel and Max Levchin | Elon Musk and Peter Thiel
Which Nigerian company did Stripe acquire in 2020? | Paystack | Flutterwave | Interswitch | Paga
Who co-founded Paystack? | Shola Akinlade and Ezra Olubi | Olugbenga Agboola and Iyinoluwa Aboyeji | Tosin Eniolorunda and Felix Ike | Babs Ogundeyi and Musty Mustapha
Who is the CEO and co-founder of Flutterwave, often called "GB"? | Olugbenga Agboola | Shola Akinlade | Iyinoluwa Aboyeji | Tayo Oviosu
Which Nigerian payments company created the Verve card and Quickteller? | Interswitch | Paystack | Flutterwave | eTranzact
Who founded Interswitch? | Mitchell Elegbe | Shola Akinlade | Tony Elumelu | Jim Ovia
What is Flutterwave's consumer remittance app called? | Send | Swap | Pay | Move
In which year was Paystack founded? | 2015 | 2010 | 2018 | 2012
In which year was Flutterwave founded? | 2016 | 2010 | 2019 | 2013
Which accelerator did Paystack join in 2016, a first for a Nigerian startup? | Y Combinator | Techstars | 500 Startups | Founders Factory
Which Kenyan company launched M-Pesa in 2007 with Vodafone? | Safaricom | Equity Bank | Airtel | KCB
What is the parent company of WorldRemit and Sendwave called? | Zepz | Western Union | MoneyGram | Wise
Which company is the oldest big name in international money transfer, founded in 1851? | Western Union | MoneyGram | Ria | Wise
What was the money transfer company Wise previously called? | TransferWise | WiseTransfer | CurrencyWise | MoneyWise
Who are the cofounders of TransferWise? | Kristo Käärmann and Taavet Hinrikus | Patrick and John Collison | Peter Thiel and Max Levchin | Nik Storonsky and Vlad Yatsenko
From which country are Wise's founders? | Estonia | Sweden | Finland | Latvia
Which British fintech founded by Nik Storonsky offers multi-currency accounts? | Revolut | Monzo | Starling | Wise
Which UK digital bank is known for its coral-coloured cards? | Monzo | Revolut | Starling | Chase UK
Which Brazilian digital bank is one of the world's largest? | Nubank | Inter | C6 | PicPay
Which Indian digital payments company's name means "pay through mobile"? | Paytm | PhonePe | Razorpay | BharatPe
Which country does the "buy now, pay later" company Klarna come from? | Sweden | Australia | United States | Germany
Which company is known for "buy now, pay later" in Australia? | Afterpay | Klarna | Affirm | Laybuy
`;
