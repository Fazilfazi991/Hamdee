(function (root) {
  'use strict';
  const TODAY = '2026-10-07', PERIOD = '2026-10';
  const round = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const sum = (items, fn = x => x) => round(items.reduce((a, x) => a + Number(fn(x) || 0), 0));
  const assert = (test, message) => { if (!test) throw new Error(message); };
  const positive = (v, label = 'Amount') => { const n = Number(v); assert(Number.isFinite(n) && n > 0, `${label} must be greater than zero.`); return round(n); };
  const nonnegative = (v, label) => { const n = Number(v); assert(Number.isFinite(n) && n >= 0, `${label} cannot be negative.`); return round(n); };
  const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const requireDate = d => assert(/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)), 'Select a valid date.');
  const requirePeriod = p => assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(p), 'Select a valid rent period.');
  const addDays = (date, days) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(days)); return d.toISOString().slice(0, 10); };
  const get = (s, type, id) => { const item = s[type].find(x => x.id === id); assert(item, 'This record could not be found.'); return item; };
  const property = (s, id) => get(s, 'properties', id);
  const activeTenant = (s, id, period = PERIOD) => s.tenants.find(t => t.pid === id && !['Vacated'].includes(t.status) && t.start.slice(0, 7) <= period && t.end.slice(0, 7) >= period);
  const expected = (s, pid, period) => {
    const tenant = activeTenant(s, pid, period);
    const base = tenant ? tenant.rent : 0;
    const incoming = sum(s.collections.filter(c => c.pid === pid && c.kind === 'Carry Forward / Rolling' && c.toPeriod === period), c => c.amount);
    const outgoing = sum(s.collections.filter(c => c.pid === pid && c.kind === 'Carry Forward / Rolling' && c.period === period), c => c.amount);
    const adjustments = sum(s.collections.filter(c => c.pid === pid && c.kind === 'Adjustment' && c.period === period), c => c.amount);
    return round(base + incoming - outgoing - adjustments);
  };
  const received = (s, pid, period) => sum(s.collections.filter(c => c.pid === pid && c.period === period && !['Adjustment', 'Carry Forward / Rolling'].includes(c.kind)), c => c.amount);
  const balance = (s, pid, period) => Math.max(0, round(expected(s, pid, period) - received(s, pid, period)));
  const service = (s, p, period) => p.startDate && period < p.startDate.slice(0, 7) ? 0 : p.chargeMode === 'Percentage' ? round(received(s, p.id, period) * p.charge / 100) : p.charge;
  const shares = (s, p) => {
    const basis = p.basis || s.settings.shareBasis;
    if (basis === 'Contribution') {
      const invested = sum(s.investments.filter(x => x.pid === p.id), x => x.amount);
      return p.partners.map(x => ({ id: x.id, share: invested ? sum(s.investments.filter(i => i.pid === p.id && i.partnerId === x.id), i => i.amount) / invested * 100 : 0 }));
    }
    return p.partners.map(x => ({ ...x }));
  };
  const financial = (s, pid, period) => {
    const p = property(s, pid), rent = activeTenant(s, pid, period)?.rent || 0;
    const cash = received(s, pid, period), expenses = s.expenses.filter(x => x.layer === 'Property' && x.pid === pid && x.date.slice(0, 7) === period && x.classification !== 'Capital');
    const otherIncome = sum(s.additional.filter(a => a.layer === 'Property' && a.pid === pid && a.kind === 'Income' && a.date.slice(0, 7) === period), a => a.amount);
    const expense = sum(expenses, x => x.amount), charge = service(s, p, period), gross = round(((p.incomeBasis || s.settings.incomeBasis) === 'Accrual' ? expected(s, pid, period) : cash) + otherIncome);
    const net = round(gross - expense - charge), ss = shares(s, p);
    const allocation = allocate(Math.max(0, net), ss);
    return { rent, expected: expected(s, pid, period), received: cash, outstanding: balance(s, pid, period), expense, charge, gross, net, otherIncome, expenses, allocation, invested: sum(s.investments.filter(x => x.pid === pid), x => x.amount), shares: ss, basis: p.incomeBasis || s.settings.incomeBasis };
  };
  function allocate(amount, ss) {
    let left = round(amount);
    return ss.map((p, i) => { const value = i === ss.length - 1 && Math.abs(sum(ss, x => x.share) - 100) < .01 ? left : round(amount * p.share / 100); left = round(left - value); return { partnerId: p.id, share: p.share, amount: value }; });
  }
  const company = (s, period) => {
    const serviceIncome = sum(s.properties, p => service(s, p, period));
    const additional = sum(s.additional.filter(x => x.layer === 'Company' && x.kind === 'Income' && x.date.slice(0, 7) === period), x => x.amount);
    const overheads = sum(s.expenses.filter(x => x.layer === 'Company' && x.date.slice(0, 7) === period), x => x.amount);
    return { serviceIncome, additional, overheads, net: round(serviceIncome + additional - overheads) };
  };
  const paid = (s, settlementId, partnerId) => sum(s.payments.filter(x => x.sid === settlementId && (!partnerId || x.partnerId === partnerId)), x => x.amount);
  const settlementDue = (s, st) => round(sum(st.allocations, x => x.amount) - paid(s, st.id));
  const partnerStats = (s, id) => {
    const properties = s.properties.filter(p => p.partners.some(x => x.id === id));
    const invested = sum(s.investments.filter(i => i.partnerId === id), x => x.amount);
    const returns = sum(s.settlements, st => sum(st.allocations.filter(a => a.partnerId === id), a => a.amount));
    const paidTotal = sum(s.payments.filter(x => x.partnerId === id), x => x.amount);
    return { properties, invested, returns, paid: paidTotal, payable: round(returns - paidTotal) };
  };
  const warrantyMatches = (s, pid, category, date = TODAY) => s.jobs.filter(j => j.pid === pid && j.category === category && j.completed && j.completed <= date && j.warrantyExpiry >= date && j.status !== 'New');
  function seed() {
    const s = { version: 1, settings: { currency: 'Riyal', incomeBasis: 'Cash', shareBasis: 'Manual', company: 'HAMDEE INTERNATIONAL', role: 'Owner / Admin' }, properties: [], partners: [], tenants: [], investments: [], collections: [], cheques: [], jobs: [], vendors: [], expenses: [], additional: [], settlements: [], payments: [], documents: [] };
    const names = ['Main Investor', 'Ahmed Al Mansoori', 'Khalid Hassan', 'Omar Al Nasser', 'Fatima Ali', 'Yusuf Rahman', 'Sara Mahmoud'];
    s.partners = names.map((name, i) => ({ id: 'a' + (i + 1), name, phone: '555 010 ' + (2100 + i * 13), email: ['investment', 'ahmed', 'khalid', 'omar', 'fatima', 'yusuf', 'sara'][i] + '@example.com', notes: i === 0 ? 'Principal investor. Participates in individual property projects.' : 'Profit shares agreed independently for each property.' }));
    const propertyNames = ['Al Rayyan Villa', 'Pearl Residence', 'Al Waab Villa', 'West Bay Residence', 'Lusail Villa', 'Al Sadd Residence', 'Garden Villa', 'Marina Residence', 'Royal Villa', 'Al Hilal Villa'];
    const locations = ['Al Rayyan · Zone 53', 'The Pearl · Porto Arabia', 'Al Waab · Zone 55', 'West Bay · Zone 61', 'Lusail · Fox Hills', 'Al Sadd · Zone 38', 'Ain Khaled · Zone 56', 'Marina District · Lusail', 'Al Thumama · Zone 46', 'Al Hilal · Zone 42'];
    const rents = [9000, 7500, 8000, 7000, 6500, 8500, 6000, 10000, 7500, 8500];
    const receivedOct = [9000, 7500, 6500, 7000, 4000, 7800, 6000, 7000];
    const owners = [[['a1', 50], ['a2', 30], ['a3', 20]], [['a1', 100]], [['a1', 60], ['a2', 40]], [['a3', 40], ['a4', 30], ['a5', 30]], [['a2', 50], ['a6', 50]], [['a1', 40], ['a3', 30], ['a7', 30]], [['a4', 100]], [['a5', 60], ['a7', 40]], [['a1', 70], ['a6', 30]], [['a2', 50], ['a3', 50]]];
    propertyNames.forEach((name, i) => {
      const pid = 'p' + (i + 1), investment = [180000, 145000, 210000, 160000, 155000, 190000, 120000, 250000, 175000, 165000][i];
      s.properties.push({ id: pid, ref: 'HI-PR-' + (101 + i), name, location: locations[i], startDate: '2026-02-' + String(10 + i).padStart(2, '0'), status: i < 8 ? 'Occupied' : 'Vacant', rent: rents[i], charge: 500, chargeMode: 'Fixed', basis: 'Manual', incomeBasis: 'Cash', notes: i < 8 ? 'Managed rental investment. Monthly review and property-specific partner allocation.' : 'Ready for leasing. Setup completed; viewings in progress.', partners: owners[i].map(([id, share]) => ({ id, share })) });
      owners[i].forEach(([id, share], k) => s.investments.push({ id: 'inv' + i + k, pid, partnerId: id, type: 'Initial property deposit', amount: investment * share / 100, date: '2026-02-' + String(10 + i).padStart(2, '0'), mode: 'Bank Transfer', ref: 'CAP-' + (2000 + i * 10 + k), notes: 'Deposit, development and furnishings contribution.' }));
      ['Property agreement', 'Partner agreement', 'Deposit proof', 'Rental agreement', 'Utility bill'].filter(x => i < 8 || x !== 'Rental agreement').forEach((type, j) => s.documents.push({ id: 'doc' + i + j, pid, type, name: name.toLowerCase().replaceAll(' ', '-') + '-' + type.toLowerCase().replaceAll(' ', '-') + '.pdf', date: '2026-02-20', size: [284, 156, 98, 340, 86][j] + ' KB', placeholder: true }));
      if (i < 8) {
        const tenantNames = ['Mohammed Al Kuwari', 'Aisha Rahman', 'Daniel Thomas', 'Abdullah Saleh', 'Nadia Hassan', 'Faisal Ibrahim', 'James Wilson', 'Leila Mahmoud'];
        const tid = 't' + (i + 1);
        s.tenants.push({ id: tid, pid, name: tenantNames[i], phone: '555 020 ' + (3100 + i * 17), email: tenantNames[i].split(' ')[0].toLowerCase() + '@example.com', document: 'ID-DEMO-' + (8020 + i), start: '2026-03-01', end: i === 3 ? '2026-10-31' : '2027-02-28', rent: rents[i], deposit: rents[i], frequency: 'Monthly', preferred: i % 3 === 0 ? 'Cheque' : 'Cash', status: 'Active', notes: 'Rent due on the first day of each month.' });
        ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', PERIOD].forEach((period, m) => s.collections.push({ id: 'r' + i + m, pid, tid, period, date: period + '-05', amount: m === 5 ? receivedOct[i] : round(rents[i] * [0.84, .91, .87, .93, .96][m]), mode: i % 3 === 0 ? 'Bank Transfer' : 'Cash', kind: m === 5 && receivedOct[i] < rents[i] ? 'Partial Payment' : 'Normal Payment', ref: 'REC-' + (1030 + i * 6 + m), by: 'Salim Ahmed', notes: 'Recorded rent receipt', attachment: '' }));
      }
    });
    s.vendors = [{ id: 'v1', name: 'CoolTech AC Services', contact: 'Rashid Khan', phone: '555 030 4201', category: 'AC', notes: 'AC servicing and compressor repairs. Warranty documented per job.' }, { id: 'v2', name: 'Al Noor Maintenance', contact: 'Imran Ali', phone: '555 030 4202', category: 'General', notes: 'Civil works, cleaning and general property repairs.' }, { id: 'v3', name: 'RapidFix Plumbing', contact: 'Joseph Mathew', phone: '555 030 4203', category: 'Plumbing', notes: 'Leak repairs, pumps and sanitary fittings.' }, { id: 'v4', name: 'Prime Electrical Works', contact: 'Bilal Hassan', phone: '555 030 4204', category: 'Electrical', notes: 'Licensed external electrical team.' }];
    const jobData = [['p1', 'AC', 'AC not cooling', 'v1', 'Under Warranty', 300, '2026-09-19', 64], ['p3', 'Plumbing', 'Kitchen pipe leaking', 'v3', 'In Progress', 450, '', 0], ['p5', 'Electrical', 'Circuit breaker trips', 'v4', 'Assigned', 380, '', 0], ['p6', 'AC', 'Bedroom AC servicing', 'v1', 'New', 250, '', 0], ['p2', 'Appliance', 'Water heater replacement', 'v2', 'Completed', 800, '2026-09-22', 90], ['p4', 'Civil', 'Balcony door alignment', 'v2', 'Closed', 350, '2026-09-05', 30], ['p7', 'Plumbing', 'Bathroom mixer repair', 'v3', 'Under Warranty', 220, '2026-09-26', 60], ['p8', 'Electrical', 'Garden lighting repair', 'v4', 'Completed', 650, '2026-10-03', 60], ['p9', 'Cleaning', 'Pre-leasing deep clean', 'v2', 'Assigned', 500, '', 0], ['p10', 'General', 'Entrance lock replacement', 'v2', 'Closed', 180, '2026-08-18', 30], ['p3', 'AC', 'Living room AC drain blockage', 'v1', 'Revisit Required', 0, '2026-09-20', 60]];
    s.jobs = jobData.map(([pid, category, issue, vid, status, cost, completed, warrantyDays], i) => ({ id: 'j' + (i + 1), ref: 'MAINT-' + (1024 + i), pid, tid: 't' + pid.slice(1), category, issue, vid, status, cost, date: completed || '2026-10-0' + (i % 5 + 1), completed, warrantyDays, warrantyExpiry: completed ? addDays(completed, warrantyDays) : '', reportedBy: 'Tenant via collection agent', invoice: completed ? 'INV-DEMO-' + (420 + i) : '', notes: 'External vendor appointment; costs belong to this property.', history: [{ date: completed || '2026-10-02', status: 'Reported' }, { date: completed || '2026-10-03', status }], expenseId: '' }));
    const expenseAmounts = [[600, 300, 200], [450, 800, 250], [700, 0, 200], [500, 350, 150], [400, 0, 250], [650, 400, 200], [350, 220, 150], [800, 650, 300], [0, 0, 0], [0, 0, 0]];
    expenseAmounts.forEach((row, i) => row.forEach((amount, j) => { if (amount) s.expenses.push({ id: 'e' + i + j, layer: 'Property', classification: 'Operating', pid: 'p' + (i + 1), category: ['Electricity', 'Maintenance', 'Cleaning'][j], amount, date: '2026-10-01', mode: 'Bank Transfer', paidBy: 'Hamdee accounts', vid: j === 1 ? s.jobs.find(x => x.pid === 'p' + (i + 1) && x.completed)?.vid || 'v2' : '', ref: 'EXP-' + (400 + i * 3 + j), notes: 'October property operating expense', attachment: '' }); }));
    s.jobs.forEach(j => { const exp = s.expenses.find(e => e.pid === j.pid && e.category === 'Maintenance' && e.amount === j.cost); if (exp && j.completed) j.expenseId = exp.id; });
    [['Collection Agent Salary', 2000], ['Mobile', 150], ['Petrol', 450], ['Office Expenses', 600]].forEach(([category, amount], i) => s.expenses.push({ id: 'ce' + i, layer: 'Company', classification: 'Operating', pid: '', category, amount, date: '2026-10-05', mode: i % 2 ? 'Cash' : 'Bank Transfer', paidBy: 'Hamdee accounts', vid: '', ref: 'CO-' + (110 + i), notes: 'Company overhead. Excluded from investor return.', attachment: '' }));
    s.additional.push({ id: 'ad1', layer: 'Company', kind: 'Income', category: 'Referral fee', description: 'Rental introduction referral', amount: 650, date: '2026-10-02', mode: 'Bank Transfer', account: 'Company operating account', pid: '', notes: 'One-off income outside the property service charge', attachment: '' });
    s.cheques = [['p1', 't1', 'Upcoming', '2026-10-10', 9000], ['p2', 't2', 'Deposited', '2026-10-08', 7500], ['p3', 't3', 'Bounced', '2026-10-04', 1500], ['p4', 't4', 'Upcoming', '2026-10-14', 7000], ['p5', 't5', 'Upcoming', '2026-10-18', 2500], ['p6', 't6', 'Replaced', '2026-10-02', 700], ['p6', 't6', 'Upcoming', '2026-10-12', 700], ['p7', 't7', 'Cleared', '2026-09-05', 5760], ['p8', 't8', 'Cancelled', '2026-10-01', 3000]].map(([pid, tid, status, date, amount], i) => ({ id: 'ch' + (i + 1), number: String(603401 + i), pid, tid, bank: ['Commercial Bank', 'QNB', 'Doha Bank'][i % 3], date, amount, period: i === 7 ? '2026-09' : i < 2 || i === 3 ? '2026-11' : PERIOD, status, replacementId: i === 5 ? 'ch7' : '', originalId: i === 6 ? 'ch6' : '', receiptId: i === 7 ? 'r64' : '', notes: 'Demo cheque. Only clearance creates a rent receipt.', history: [{ date: '2026-10-01', status: 'Received' }, { date, status }] }));
    // The cleared cheque references an existing receipt; no second receipt is created.
    s.cheques[7].amount = s.collections.find(x => x.id === 'r64').amount;
    s.collections.find(x => x.id === 'r64').mode = 'Cheque';
    ['p1', 'p2', 'p3'].forEach(pid => {
      const st = generateSettlement(s, { pid, period: PERIOD });
      if (pid === 'p1') s.payments.push({ id: 'pay1', sid: st.id, partnerId: 'a1', amount: 2000, date: TODAY, mode: 'Bank Transfer', ref: 'SET-1001', notes: 'Partial settlement' });
      if (pid === 'p2') s.payments.push({ id: 'pay2', sid: st.id, partnerId: 'a1', amount: 5000, date: TODAY, mode: 'Bank Transfer', ref: 'SET-1002', notes: 'Partial settlement' });
    });
    return s;
  }
  function saveProperty(s, d, id) {
    assert(d.name?.trim(), 'Enter a property name.'); assert(d.location?.trim(), 'Enter a location.');
    const p = id ? property(s, id) : { id: uid('p'), ref: 'HI-PR-' + (101 + s.properties.length), startDate: TODAY, partners: [] };
    assert(!s.properties.some(x => x.id !== p.id && x.name.toLowerCase() === d.name.trim().toLowerCase()), 'A property with this name already exists.');
    const values = { name: d.name.trim(), location: d.location.trim(), status: d.status, rent: nonnegative(d.rent, 'Monthly rent'), charge: nonnegative(d.charge, 'Service charge'), chargeMode: d.chargeMode, basis: d.basis, incomeBasis: d.incomeBasis, notes: d.notes || '' };
    assert(values.chargeMode !== 'Percentage' || values.charge <= 100, 'Percentage service charge cannot exceed 100%.');
    assert(values.status !== 'Vacant' || !activeTenant(s, p.id), 'Vacate the current rental agreement before marking this property vacant.');
    assert(values.status !== 'Occupied' || activeTenant(s, p.id), 'Add a tenant agreement before marking this property occupied.');
    if (!id) { assert(d.partnerId, 'Select the initial partner.'); get(s, 'partners', d.partnerId); p.partners = [{ id: d.partnerId, share: 100 }]; s.properties.push(p); }
    Object.assign(p, values); return p;
  }
  function addPartner(s, d) { assert(d.name?.trim() && d.phone?.trim(), 'Enter the partner name and phone.'); const p = { ...d, id: uid('a'), name: d.name.trim() }; s.partners.push(p); return p; }
  function addInvestment(s, d) {
    const p = property(s, d.pid); get(s, 'partners', d.partnerId); requireDate(d.date);
    const inv = { ...d, id: uid('inv'), amount: positive(d.amount) };
    assert(p.partners.some(x => x.id === d.partnerId), 'Add this partner to the property participation first.');
    s.investments.push(inv); return inv;
  }
  function saveShares(s, pid, entries, basis) {
    const p = property(s, pid); assert(entries.length > 0, 'Keep at least one partner.');
    assert(new Set(entries.map(e => e.id)).size === entries.length, 'Each partner can appear only once.');
    entries.forEach(e => { get(s, 'partners', e.id); e.share = nonnegative(e.share, 'Share'); });
    assert(basis === 'Contribution' || Math.abs(sum(entries, x => x.share) - 100) < .01, 'Manual shares must total exactly 100%.');
    const funded = s.investments.filter(i => i.pid === pid).map(i => i.partnerId);
    assert(funded.every(id => entries.some(e => e.id === id)), 'A partner with an existing investment must remain in this property.');
    p.partners = entries; p.basis = basis; return p;
  }
  function saveTenant(s, d, id) {
    const p = property(s, d.pid); requireDate(d.start); requireDate(d.end); assert(d.start < d.end, 'Agreement end must follow its start.');
    assert(d.name?.trim() && d.phone?.trim(), 'Enter tenant name and phone.');
    assert(!s.tenants.some(t => t.id !== id && t.pid === d.pid && t.status !== 'Vacated' && d.status !== 'Vacated' && t.start <= d.end && t.end >= d.start), 'This property already has an overlapping rental agreement.');
    const t = { ...d, id: id || uid('t'), rent: positive(d.rent, 'Rent'), deposit: nonnegative(d.deposit, 'Deposit') };
    if (id) Object.assign(get(s, 'tenants', id), t); else s.tenants.push(t);
    p.status = d.status === 'Vacated' ? 'Vacant' : 'Occupied'; p.rent = t.rent; return t;
  }
  function recordCollection(s, d) {
    property(s, d.pid); const t = get(s, 'tenants', d.tid); assert(t.pid === d.pid, 'Tenant must belong to the selected property.'); requireDate(d.date); requirePeriod(d.period);
    const amount = positive(d.amount); const due = balance(s, d.pid, d.period);
    assert(d.kind !== 'Cheque Replacement', 'Use the original cheque detail to link a replacement.');
    assert(d.mode !== 'Adjustment' || d.kind === 'Adjustment', 'Select the Adjustment transaction type for a non-cash adjustment.');
    assert(d.mode !== 'Carry Forward / Rolling' || d.kind === 'Carry Forward / Rolling', 'Select the Carry Forward / Rolling transaction type to move an unpaid balance.');
    if (d.kind === 'Carry Forward / Rolling') { requirePeriod(d.toPeriod); assert(d.toPeriod > d.period, 'Carry forward must move to a later rent period.'); assert(amount <= due, 'Carry forward cannot exceed the unpaid balance.'); }
    if (d.kind === 'Adjustment') assert(amount <= due, 'Adjustment cannot exceed the unpaid balance.');
    if (!['Advance', 'Adjustment', 'Carry Forward / Rolling'].includes(d.kind)) assert(amount <= due, 'This amount exceeds the rent balance. Use Advance for prepaid rent.');
    if (d.mode === 'Cheque' && !['Adjustment', 'Carry Forward / Rolling'].includes(d.kind)) return createCheque(s, { ...d, amount, number: d.chequeNumber, bank: d.bank, date: d.chequeDate || d.date });
    const c = { ...d, id: uid('r'), amount, mode: ['Adjustment', 'Carry Forward / Rolling'].includes(d.kind) ? d.kind : d.mode }; s.collections.push(c); return c;
  }
  function createCheque(s, d, originalId) {
    property(s, d.pid); const t = get(s, 'tenants', d.tid); assert(t.pid === d.pid, 'Tenant must belong to this property.'); requireDate(d.date); requirePeriod(d.period);
    assert(d.number?.trim() && d.bank?.trim(), 'Enter cheque number and bank.');
    assert(!s.cheques.some(c => c.number === d.number.trim() && c.bank.toLowerCase() === d.bank.trim().toLowerCase()), 'This cheque number is already recorded for that bank.');
    const original = originalId ? get(s, 'cheques', originalId) : null;
    assert(!original || !['Cleared', 'Replaced', 'Cancelled'].includes(original.status), 'Only an uncleared original cheque can be replaced.');
    const c = { ...d, id: uid('ch'), amount: positive(d.amount), number: d.number.trim(), bank: d.bank.trim(), status: 'Upcoming', originalId: originalId || '', replacementId: '', receiptId: '', history: [{ date: TODAY, status: 'Received' }] };
    if (original) { assert(c.pid === original.pid && c.tid === original.tid, 'Replacement must belong to the original property and tenant.'); original.status = 'Replaced'; original.replacementId = c.id; original.history.push({ date: TODAY, status: 'Replaced', note: c.number }); }
    s.cheques.push(c); return c;
  }
  function chequeStatus(s, id, status) {
    const c = get(s, 'cheques', id); assert(!['Cleared', 'Replaced', 'Cancelled'].includes(c.status), 'This cheque is finalized.');
    assert(['Deposited', 'Cleared', 'Bounced', 'Cancelled'].includes(status), 'Choose a valid cheque action.');
    if (status === 'Cleared') { assert(c.status === 'Deposited', 'Deposit the cheque before clearing it.'); assert(!c.receiptId, 'This cheque already has a receipt.'); const receipt = { id: uid('r'), pid: c.pid, tid: c.tid, period: c.period, amount: c.amount, date: TODAY, mode: 'Cheque', kind: 'Normal Payment', by: 'Hamdee accounts', ref: c.number, notes: 'Cleared cheque ' + c.number, chequeId: c.id }; s.collections.push(receipt); c.receiptId = receipt.id; }
    c.status = status; c.history.push({ date: TODAY, status }); return c;
  }
  function addExpense(s, d) {
    assert(['Property', 'Company'].includes(d.layer), 'Choose the financial layer.'); requireDate(d.date); if (d.layer === 'Property') property(s, d.pid);
    assert(d.category && d.paidBy, 'Enter category and paid by.'); const e = { ...d, id: uid('e'), pid: d.layer === 'Property' ? d.pid : '', amount: positive(d.amount) }; s.expenses.push(e); return e;
  }
  function addAdditional(s, d) {
    requireDate(d.date); assert(d.description?.trim(), 'Enter a description.'); if (d.layer === 'Property') property(s, d.pid);
    const a = { ...d, id: uid('ad'), amount: positive(d.amount), pid: d.layer === 'Property' ? d.pid : '' };
    s.additional.push(a);
    if (d.kind === 'Expense') s.expenses.push({ ...a, id: uid('e'), category: d.category || 'Other', classification: 'Operating', paidBy: 'Hamdee accounts', additionalId: a.id, notes: d.description });
    return a;
  }
  function createJob(s, d) {
    property(s, d.pid); requireDate(d.date); assert(d.issue?.trim(), 'Describe the issue.');
    const matches = warrantyMatches(s, d.pid, d.category, d.date);
    assert(!matches.length || d.previousId || d.override === 'yes', 'Warranty match detected. Link the previous job or choose Continue Anyway.');
    if (d.vid) get(s, 'vendors', d.vid);
    const j = { ...d, id: uid('j'), ref: 'MAINT-' + (1024 + s.jobs.length), cost: nonnegative(d.cost, 'Estimated cost'), status: d.previousId ? 'Revisit Required' : d.vid ? 'Assigned' : 'New', completed: '', warrantyDays: 0, warrantyExpiry: '', expenseId: '', history: [{ date: d.date, status: 'Reported' }] };
    s.jobs.push(j); return j;
  }
  function updateJob(s, id, d) {
    const j = get(s, 'jobs', id); assert(d.vid, 'Choose an external vendor.'); get(s, 'vendors', d.vid);
    const cost = nonnegative(d.cost, 'Cost'), days = nonnegative(d.warrantyDays || 0, 'Warranty days');
    const completing = ['Completed', 'Under Warranty', 'Closed'].includes(d.status);
    if (completing) { requireDate(d.completed); assert(d.completed >= j.date, 'Completion cannot precede the reported date.'); assert(d.completed <= TODAY, 'Completion cannot be in the future in this demo period.'); }
    if (j.expenseId) assert(cost === j.cost, 'This cost is already in the property ledger. Add a separate adjustment expense.');
    Object.assign(j, { vid: d.vid, cost, status: d.status, completed: completing ? d.completed : j.completed, warrantyDays: days, warrantyExpiry: completing && days ? addDays(d.completed, days) : j.warrantyExpiry, invoice: d.invoice, notes: d.notes });
    if (completing && !j.expenseId && cost > 0) { const e = addExpense(s, { layer: 'Property', pid: j.pid, category: 'Maintenance', amount: cost, date: d.completed, mode: d.mode || 'Bank Transfer', paidBy: 'Hamdee accounts', vid: d.vid, classification: 'Operating', notes: j.ref + ' — ' + j.issue, ref: d.invoice || j.ref }); j.expenseId = e.id; }
    j.history.push({ date: TODAY, status: d.status }); return j;
  }
  function generateSettlement(s, d) {
    requirePeriod(d.period); const p = property(s, d.pid); const f = financial(s, d.pid, d.period);
    assert(!s.settlements.some(x => x.pid === d.pid && x.period === d.period), 'A settlement already exists for this property and period.');
    assert(f.net > 0, 'There is no positive return to distribute for this period.'); assert(Math.abs(sum(f.shares, x => x.share) - 100) < .01, 'Partner shares must total 100% before settlement.');
    const st = { id: uid('st'), ref: 'SET-' + (1001 + s.settlements.length), pid: p.id, period: d.period, date: TODAY, gross: f.gross, cash: f.received, expenses: f.expense, charge: f.charge, net: f.net, basis: f.basis, shareBasis: p.basis || s.settings.shareBasis, allocations: f.allocation.map(a => ({ ...a })), carried: [], notes: d.notes || '' }; s.settlements.push(st); return st;
  }
  function payPartner(s, d) {
    const st = get(s, 'settlements', d.sid), a = st.allocations.find(x => x.partnerId === d.partnerId); assert(a, 'This partner is not in the settlement.'); requireDate(d.date);
    const due = round(a.amount - paid(s, st.id, a.partnerId));
    if (d.action === 'Carry Forward') { assert(due > 0, 'There is no balance to carry forward.'); if (!st.carried.includes(a.partnerId)) st.carried.push(a.partnerId); return st; }
    const amount = positive(d.amount); assert(amount <= due, 'Payment cannot exceed this partner’s unpaid allocation.');
    assert(st.basis !== 'Accrual' || sum(st.allocations, x => x.amount) <= Math.max(0, st.cash - st.expenses - st.charge), 'Accrued profit exceeds available cash. Record collections and review the settlement before payment.');
    const pay = { ...d, id: uid('pay'), amount }; s.payments.push(pay); return pay;
  }
  const totals = (s, period) => {
    const fs = s.properties.map(p => financial(s, p.id, period));
    return { properties: s.properties.length, occupied: s.properties.filter(p => activeTenant(s, p.id, period)).length, rent: sum(fs, f => f.rent), received: sum(fs, f => f.received), outstanding: sum(fs, f => f.outstanding), expenses: sum(fs, f => f.expense), net: sum(fs, f => f.net), payable: sum(s.settlements, st => settlementDue(s, st)), company: company(s, period) };
  };
  root.HamdeeModel = { TODAY, PERIOD, round, sum, positive, uid, addDays, get, activeTenant, expected, received, balance, service, shares, financial, company, paid, settlementDue, partnerStats, warrantyMatches, seed, saveProperty, addPartner, addInvestment, saveShares, saveTenant, recordCollection, createCheque, chequeStatus, addExpense, addAdditional, createJob, updateJob, generateSettlement, payPartner, totals, allocate };
  if (typeof module !== 'undefined') module.exports = root.HamdeeModel;
})(typeof window !== 'undefined' ? window : globalThis);
