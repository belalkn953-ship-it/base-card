(() => {
  const byId = (id) => document.getElementById(id);
  const panel = byId('myPaymentsPanel');
  const list = byId('myPaymentsList');
  const toggle = byId('myPaymentsToggle');
  const refresh = byId('myPaymentsRefresh');
  const transactionsPanel = byId('walletTransactionsPanel');
  const transactionsToggle = byId('walletTransactionsToggle');
  if (!panel || !list || !toggle || !refresh || !transactionsPanel || !transactionsToggle) return;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
  const moneyText = (amount, currency) => currency === 'USD'
    ? `${Number(amount || 0).toFixed(2)} $`
    : `${Number(amount || 0).toLocaleString('ar-SY', { maximumFractionDigits: 2 })} ل.س`;
  const statusText = (status) => ({
    pending: ['قيد المراجعة', ''],
    approved: ['مقبولة', 'completed'],
    rejected: ['مرفوضة', 'rejected']
  })[String(status || '').toLowerCase()] || ['قيد المراجعة', ''];

  async function loadPayments() {
    list.innerHTML = '<p class="muted">جارٍ تحميل دفعاتك...</p>';
    try {
      const { data: auth } = await sb.auth.getUser();
      if (!auth?.user) {
        list.innerHTML = '<p class="muted">سجّل الدخول لعرض دفعاتك.</p>';
        return;
      }
      const { data, error } = await sb.from('topup_requests')
        .select('id,amount,currency,payment_number,status,created_at')
        .eq('user_id', auth.user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      if (!data?.length) {
        list.innerHTML = '<p class="muted">لا توجد دفعات حتى الآن.</p>';
        return;
      }
      list.innerHTML = data.map((payment) => {
        const [label, className] = statusText(payment.status);
        const date = payment.created_at
          ? new Date(payment.created_at).toLocaleString('ar-SY', { timeZone: 'Asia/Damascus' })
          : '—';
        return `<article class="track-order payment-row" style="padding:10px 12px;margin:8px 0;font-size:12px">
          <div><b>دفعة #${escapeHtml(payment.id)}</b><span class="status ${className}">${label}</span></div>
          <p>رقم العملية: ${escapeHtml(payment.payment_number || '—')}</p>
          <small>المبلغ: ${moneyText(payment.amount, payment.currency)}<br>التاريخ: ${escapeHtml(date)}</small>
        </article>`;
      }).join('');
    } catch (_) {
      list.innerHTML = '<p class="muted">تعذر تحميل الدفعات الآن. حاول التحديث مرة أخرى.</p>';
    }
  }

  function switchPanel(nextPanel, nextToggle) {
    const opening = nextPanel.classList.contains('hidden');
    [panel, transactionsPanel].forEach((item) => item.classList.add('hidden'));
    [toggle, transactionsToggle].forEach((button) => button.setAttribute('aria-expanded', 'false'));
    if (opening) {
      nextPanel.classList.remove('hidden');
      nextToggle.setAttribute('aria-expanded', 'true');
    }
    return opening;
  }

  toggle.addEventListener('click', async () => {
    if (switchPanel(panel, toggle)) await loadPayments();
  });
  transactionsToggle.addEventListener('click', () => switchPanel(transactionsPanel, transactionsToggle));
  refresh.addEventListener('click', loadPayments);
})();
