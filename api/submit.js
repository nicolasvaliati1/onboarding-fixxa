// Receives the briefing from the page, drops junk, then delivers it two ways:
// the Make webhook and an email with the PDF attached (Resend). The submission
// counts as received if at least one of them works, so a Make outage loses nothing.
//
// Env vars (Vercel > Settings > Environment Variables):
//   MAKE_WEBHOOK_URL  Make webhook URL (kept off the public page)
//   RESEND_API_KEY    Resend API key
//   EMAIL_FROM        sender on a domain verified in Resend, e.g. "FIXXA <onboarding@fixxamarketing.com.br>"
//   EMAIL_TO          recipients, comma-separated

const json = (status, obj) => Response.json(obj, { status });
const isFile = v => v && typeof v === 'object' && typeof v.arrayBuffer === 'function';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function POST(request) {
  let data;
  try { data = await request.formData(); } catch (e) { return json(400, { error: 'invalid body' }); }

  // Honeypot filled or core fields missing: a bot or a stray request, not a real submission
  const empresa = String(data.get('empresa') || '').trim();
  const email = String(data.get('e_mail_da_empresa') || '').trim();
  const pdf = data.get('pdf');
  if (data.get('website') || !empresa || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !isFile(pdf) || !pdf.size) {
    return json(400, { error: 'invalid submission' });
  }
  data.delete('website');

  const [make, mail] = await Promise.allSettled([toMake(data), toEmail(data, empresa)]);
  [make, mail].forEach((r, i) => r.status === 'rejected' && console.error(i ? 'Email:' : 'Make:', r.reason));
  if (make.status === 'rejected' && mail.status === 'rejected') return json(502, { error: 'delivery failed' });
  return json(200, { make: make.status === 'fulfilled', email: mail.status === 'fulfilled' });
}

async function toMake(data) {
  if (!process.env.MAKE_WEBHOOK_URL) throw new Error('MAKE_WEBHOOK_URL not set');
  const res = await fetch(process.env.MAKE_WEBHOOK_URL, { method: 'POST', body: data });
  if (!res.ok) throw new Error('Make responded ' + res.status);
}

async function toEmail(data, empresa) {
  const { RESEND_API_KEY, EMAIL_FROM, EMAIL_TO } = process.env;
  if (!RESEND_API_KEY || !EMAIL_FROM || !EMAIL_TO) throw new Error('email env vars not set');

  const rows = [], attachments = [];
  for (const [key, value] of data.entries()) {
    if (isFile(value)) {
      attachments.push({ filename: value.name, content: Buffer.from(await value.arrayBuffer()).toString('base64') });
    } else if (key !== 'email_destino') {
      rows.push(`<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top">${esc(key)}</td><td style="padding:6px 0">${esc(value) || '-'}</td></tr>`);
    }
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: EMAIL_TO.split(',').map(s => s.trim()).filter(Boolean),
      reply_to: String(data.get('e_mail_da_empresa')),
      subject: 'Novo briefing de onboarding: ' + empresa,
      html: `<p>Novo briefing recebido. O PDF e os arquivos enviados estão em anexo.</p><table style="font:14px sans-serif;border-collapse:collapse">${rows.join('')}</table>`,
      attachments
    })
  });
  if (!res.ok) throw new Error('Resend responded ' + res.status + ': ' + await res.text());
}
