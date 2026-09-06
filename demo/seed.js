// Runs once, on first start, against the `demo` database.
// Deterministic on purpose: the same fixture every time you reset.
let seed = 20260906
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const pick = (list) => list[Math.floor(rnd() * list.length)]
const money = (n) => Decimal128.fromString(n.toFixed(2))
const day = 86400000
const start = new Date('2026-01-07T09:00:00Z').getTime()

// ─── customers ────────────────────────────────────────────────
// vatNumber and iban are deliberately sensitive: the MCP config
// must be able to hide them while still filtering on the rest.
const customers = [
  [
    'CUST-001',
    'Panificio Esposito',
    'ordini@esposito.it',
    'IT01234567890',
    'IT60X0542811101000000123456',
    'IT',
    'retail'
  ],
  [
    'CUST-002',
    'Vivai Costiera SRL',
    'admin@vivaicostiera.it',
    'IT09876543210',
    'IT28W8000000292100645211151',
    'IT',
    'wholesale'
  ],
  [
    'CUST-003',
    'Nordic Furniture AB',
    'purchase@nordicfur.se',
    'SE556677889901',
    'SE3550000000054910000003',
    'SE',
    'wholesale'
  ],
  [
    'CUST-004',
    'Bar Centrale Pompei',
    'info@barcentrale.it',
    'IT11223344556',
    'IT43K0300203280000000654321',
    'IT',
    'retail'
  ],
  [
    'CUST-005',
    'Atelier Lumière SARL',
    'contact@lumiere.fr',
    'FR40303265045',
    'FR7630006000011234567890189',
    'FR',
    'retail'
  ]
].map(([code, name, email, vatNumber, iban, country, segment], i) => ({
  _id: new ObjectId(),
  code,
  name,
  email,
  vatNumber,
  iban,
  country,
  segment,
  creditLimit: money([5000, 25000, 40000, 3000, 8000][i]),
  createdAt: new Date(start - (400 - i * 30) * day),
  // Note: CUST-005 has NO `deleted` field at all - older record,
  // written before the soft-delete flag existed.
  ...(i === 4 ? {} : { deleted: i === 3 })
}))
db.customers.insertMany(customers)

// ─── products ─────────────────────────────────────────────────
// `cost` is the margin: readable by the server, never by the model.
const products = [
  ['SKU-1001', 'Farina tipo 00 25kg', 'ingredienti', 22.4, 14.1, 340],
  ['SKU-1002', 'Lievito madre essiccato', 'ingredienti', 8.9, 4.35, 120],
  ['SKU-2001', 'Teglia alluminio 60x40', 'attrezzatura', 31.0, 19.8, 85],
  ['SKU-2002', 'Impastatrice a spirale 20L', 'attrezzatura', 1290.0, 940.0, 6],
  ['SKU-3001', 'Sacchetti carta kraft 1kg', 'packaging', 0.14, 0.07, 12000],
  ['SKU-3002', 'Scatole pizza 33cm', 'packaging', 0.31, 0.19, 4800],
  ['SKU-4001', 'Olio EVO 5L', 'ingredienti', 41.5, 28.0, 210],
  ['SKU-4002', 'Pomodoro San Marzano DOP 3kg', 'ingredienti', 9.8, 5.9, 660]
].map(([sku, name, category, price, cost, stock], i) => ({
  _id: new ObjectId(),
  sku,
  name,
  category,
  price: money(price),
  cost: money(cost),
  stock,
  active: i !== 3,
  deleted: false
}))
db.products.insertMany(products)

// ─── orders ───────────────────────────────────────────────────
const statuses = ['placed', 'picking', 'shipped', 'delivered', 'cancelled']
const orders = []

for (let i = 1; i <= 120; i++) {
  const customer = pick(customers)
  const lineCount = 1 + Math.floor(rnd() * 3)
  const items = []
  let total = 0

  for (let l = 0; l < lineCount; l++) {
    const product = pick(products)
    const quantity = 1 + Math.floor(rnd() * 12)
    const unitPrice = Number.parseFloat(product.price.toString())
    total += unitPrice * quantity
    items.push({
      productId: product._id,
      sku: product.sku,
      quantity,
      unitPrice: product.price
    })
  }

  orders.push({
    _id: new ObjectId(),
    number: `ORD-2026-${String(i).padStart(4, '0')}`,
    customerId: customer._id,
    customerCode: customer.code,
    status: pick(statuses),
    channel: pick(['web', 'phone', 'rep']),
    placedAt: new Date(start + i * 2 * day),
    items,
    total: money(total),
    currency: 'EUR',
    // The first 12 orders predate the soft-delete flag and have no
    // `deleted` field: { deleted: false } would hide them.
    ...(i <= 12 ? {} : { deleted: i % 17 === 0 })
  })
}
db.orders.insertMany(orders)

// ─── invoices ─────────────────────────────────────────────────
const invoices = orders
  .filter((order) => order.status === 'delivered' || order.status === 'shipped')
  .map((order, i) => {
    const net = Number.parseFloat(order.total.toString())
    const vat = net * 0.22
    return {
      _id: new ObjectId(),
      number: `INV-2026-${String(i + 1).padStart(4, '0')}`,
      orderId: order._id,
      customerId: order.customerId,
      issuedAt: new Date(order.placedAt.getTime() + 3 * day),
      dueAt: new Date(order.placedAt.getTime() + 33 * day),
      net: money(net),
      vatAmount: money(vat),
      total: money(net + vat),
      currency: 'EUR',
      status: pick(['issued', 'paid', 'overdue']),
      internalNote: 'Cliente da richiamare per insoluti pregressi',
      deleted: false
    }
  })
db.invoices.insertMany(invoices)

// ─── indexes ──────────────────────────────────────────────────
db.customers.createIndex({ code: 1 }, { unique: true })
db.products.createIndex({ sku: 1 }, { unique: true })
db.orders.createIndex({ number: 1 }, { unique: true })
db.orders.createIndex({ customerId: 1, placedAt: -1 })
db.orders.createIndex({ status: 1 })
db.invoices.createIndex({ number: 1 }, { unique: true })
db.invoices.createIndex({ orderId: 1 })

// ─── read-only user for the MCP server ────────────────────────
// The strongest guarantee in the whole stack: even a bug in the
// validator cannot write through a connection that has no such right.
db.createUser({
  user: 'mcp_reader',
  pwd: 'mcp_reader_pw',
  roles: [{ role: 'read', db: 'demo' }]
})

print(
  `seeded: ${db.customers.countDocuments()} customers, ${db.products.countDocuments()} products, ${db.orders.countDocuments()} orders, ${db.invoices.countDocuments()} invoices`
)
