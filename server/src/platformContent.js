// The platform's own pages: the home page at `/` and the PDPA privacy notice.
//
// These are not a shop's to change and are not the software's buttons. They are
// the wording the platform publishes: the page a visitor lands on, and the legal
// document a customer is entitled to read. Both belong to whoever runs the
// platform, so both are edited in one place and apply everywhere.
//
// A shop's own wording is a different thing entirely and is not here. Neither are
// the app's buttons, "Add to basket" and the rest: those are the software's, and
// a shop that wants different wording for them is changing its own store, not the
// platform.
//
// Bilingual by construction rather than by translation pass. Every string has an
// English and a Thai version side by side, because a legal notice in Thai is not a
// translated copy of one in English: it is the document a Thai customer actually
// reads, and translating it later produces a worse one.

const { coll, nextId, now, touch } = require('./db');
const { UI_STRINGS } = require('./i18n/engine');

// scope: which platform page the string belongs to, so the editor can group them
// and so a later page can be added without disturbing the others.
const CONTENT = {
  privacy: {
    title: {
      en: 'Privacy notice', th: 'นโยบายความเป็นส่วนตัว',
    },
    subtitle: {
      en: 'How this shop handles your personal data under the Personal Data Protection Act B.E. 2562 (PDPA).',
      th: 'เอกสารฉบับนี้อธิบายว่าร้านเก็บข้อมูลส่วนบุคคลของคุณอย่างไร ตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562',
    },
    controllerWarning: {
      en: 'This shop has not filled in its legal name and privacy contact yet. Set them in the shop settings.',
      th: 'ร้านยังไม่ได้กรอกชื่อทางกฎหรืออีเมลติดต่อเรื่องข้อมูลส่วนบุคคลให้ครบ กรุณาตั้งค่าในหน้าตั้งค่าร้าน',
    },
    loadFailed: {
      en: 'This privacy notice could not be loaded. Please contact the shop directly.',
      th: 'ยังเปิดหน้านโยบายความเป็นส่วนตัวนี้ไม่ได้ กรุณาติดต่อร้านโดยตรง',
    },

    'controller.heading': { en: 'Who is responsible', th: 'ผู้ควบคุมข้อมูล' },
    'controller.body': {
      en: 'Your data is held by this shop as the data controller.',
      th: 'ข้อมูลของคุณถูกเก็บโดยร้านนี้ในฐานะผู้ควบคุมข้อมูลส่วนบุคคล',
    },
    'controller.legalNameLabel': { en: 'Legal name', th: 'ชื่อทางกฎ' },
    'controller.contactLabel': { en: 'Privacy contact', th: 'อีเมลติดต่อเรื่องข้อมูลส่วนบุคคล' },
    'controller.retentionLabel': { en: 'How long we keep it', th: 'ระยะเวลาการเก็บรักษา' },
    'controller.versionLabel': { en: 'Notice version', th: 'เวอร์ชันนโยบาย' },
    'controller.addressLabel': { en: 'Address', th: 'ที่อยู่' },
    'controller.notSet': { en: 'Not set yet', th: 'ยังไม่ได้ระบุ' },
    'controller.retentionDays': { en: '{n} days from the date you joined', th: '{n} วัน นับจากวันที่สมัคร' },
    'controller.retentionUntilAsked': { en: 'Until you ask us to delete it', th: 'จนกว่าคุณจะขอลบ' },

    'collect.heading': { en: 'What we collect, and why', th: 'เราเก็บข้อมูลอะไร และเพื่ออะไร' },
    'collect.body': {
      en: 'We collect only what the service you asked for needs: your name, phone number, email address, and loyalty points. We do not collect payment card numbers, and we never sell your data.',
      th: 'เราเก็บเฉพาะข้อมูลที่จำเป็นต่อบริการที่คุณขอ ได้แก่ ชื่อ หมายเลขโทรศัพท์ อีเมล และยอดคะแนนสะสม',
    },

    'rights.heading': { en: 'Your rights', th: 'สิทธิของคุณ' },
    'rights.body': {
      en: 'The PDPA gives you the following rights. You can exercise any of them at any time by contacting us using the details above.',
      th: 'คุณมีสิทธิตามพระราชบัญญัติฉบับนี้ และสามารถใช้สิทธิได้ทุกเมื่อ โดยติดต่อเราตามข้อมูลด้านบน',
    },
    'rights.footer': {
      en: 'We respond within the period the law allows. If we cannot action a request we will say so in writing and explain why.',
      th: 'ร้านจะตอบกลับภายในระยะเวลาที่กฎหมายกำหนด หากเราไม่สามารถปฏิบัติตาม เราจะแจ้งเหตุผลเป็นลายลักษณ์อักษร',
    },
    'rights.access': { en: 'Ask for a copy of your data', th: 'ขอสำเนาข้อมูลของคุณ' },
    'rights.correct': { en: 'Ask for your data to be corrected', th: 'ขอแก้ไขข้อมูลที่ไม่ถูกต้อง' },
    'rights.erase': { en: 'Ask for your data to be deleted', th: 'ขอลบข้อมูลของคุณ' },
    'rights.withdraw': { en: 'Withdraw consent', th: 'ถอนยินยอม' },
    'rights.object': { en: 'Object to processing', th: 'คัดค้านการประมวลผลข้อมูล' },

    'security.heading': { en: 'Security and storage', th: 'ความปลอดภัยและการเก็บรักษา' },
    'security.body': {
      en: 'Passwords are stored as salted hashes, the data file is not reachable from the internet, access is limited to staff who need it, and every access to, export of, or deletion of personal data is written to the audit log.',
      th: 'ข้อมูลถูกเข้ารหัสรหัสผ่านด้วยวิธีที่เหมาะสม และเก็บไว้บนเซิร์ฟเวอร์ของเรา เราจำกัดการเข้าถึงเฉพาะพนักงานที่จำเป็นต้องรู้ และบันทึกการเข้าถึงข้อมูลส่วนบุคคลไว้ในบันทึกการตรวจสอบ',
    },
    'security.breach': {
      en: 'If personal data is breached we will notify the PDPC and any affected customer as the law requires.',
      th: 'หากเกิดเหตุละเลยข้อมูล เราจะแจ้งสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคลตามกำหนดกฎหมาย',
    },

    'cookies.heading': {
      en: 'Cookies and what we store in your browser',
      th: 'คุกกี้และสิ่งที่เราเก็บไว้ในเบราว์เซอร์ของคุณ',
    },
    // Accurate rather than reassuring. This site sets no cookies at all: there is
    // no cookie banner because there is nothing to consent to, and saying
    // otherwise would be both false and a habit worth not starting.
    'cookies.body': {
      en: 'We set no cookies. Nothing on this site is stored by a cookie, and there is no tracking, no advertising cookie and no third-party analytics cookie. When you sign in, your session is kept in your browser\'s session storage, which is cleared when you close the tab. We also remember three small preferences in local storage: which language you chose, which store you last used, and which branch you last selected. Those never leave your device, they contain no customer data, and clearing your browser data removes them.',
      th: 'เราไม่ตั้งคุกกี้เลย ไม่มีการติดตาม ไม่มีคุกกี้โฆษณา และไม่มีคุกกี้วิเคราะห์จากบุคคลที่สาม เมื่อคุณเข้าสู่ระบบ เซสชันของคุณจะถูกเก็บใน session storage ของเบราว์เซอร์ และจะหายไปเมื่อคุณปิดแท็บ เรายังจดจำค่ากำหนดเล็ก ๆ สามรายการใน local storage ได้แก่ ภาษาที่คุณเลือก ร้านที่คุณใช้ล่าสุด และสาขาที่คุณเลือกล่าสุด ข้อมูลเหล่านี้ไม่ออกจากเครื่องของคุณ ไม่มีข้อมูลลูกค้าอยู่ในนั้น และจะหายไปเมื่อคุณล้างข้อมูลเบราว์เซอร์',
    },
    'cookies.none': {
      en: 'No cookies are used on this site.',
      th: 'เว็บไซต์นี้ไม่ใช้คุกกี้',
    },

    'storage.heading': { en: 'Cookies and browser storage', th: 'คุกกี้และข้อมูลในเบราว์เซอร์' },
    'contact.heading': { en: 'Contact us', th: 'ติดต่อเรา' },
    'contact.fallback': { en: 'Ask any member of staff', th: 'ติดต่อทางร้าน' },
    'contact.retentionHeading': { en: 'Retention', th: 'ระยะเวลาการเก็บรักษา' },
    'contact.retentionDays': { en: '{n} days', th: '{n} วัน' },
    'contact.versionHeading': { en: 'Document version', th: 'เวอร์ชันเอกสาร' },
    'contact.home': { en: '← Home', th: '← หน้าแรก' },
  },

  // The landing page's own strings. Kept bilingual because the shop-facing pages
  // are, and because a notice a customer cannot read is not a notice.
  //
  // This build has no trial, no plans and no hosted signup, so the whole
  // hero/trial/plans set from the hosted build is gone rather than reworded.
  // What is left describes what the software is and where to get it.
  landing: {
    'hero.eyebrow': { en: 'Open source, self hosted, yours', th: 'โอเพนซอร์ส ติดตั้งเอง เป็นของคุณ' },
    'hero.heading': { en: 'Your shop. Your server. Your data.', th: 'ร้านของคุณ เซิร์ฟเวอร์ของคุณ ข้อมูลของคุณ' },
    'hero.lede': {
      en: 'A complete point of sale that runs on a machine you control. No account, no subscription, no key to activate, and nothing phoning home.',
      th: 'ระบบขายหน้าร้านครบวงจรที่ทำงานบนเครื่องของคุณเอง ไม่ต้องสมัครใช้ ไม่มีค่าบริการรายเดือน ไม่ต้องรอคีย์ และไม่มีการส่งข้อมูลออกไปข้างนอก',
    },
    'hero.ctaSignIn': { en: 'Sign in', th: 'เข้าสู่ระบบ' },
    'hero.ctaSetup': { en: 'Set up this install', th: 'ตั้งค่าระบบนี้' },
    'hero.ctaInstall': { en: 'How to install it', th: 'วิธีติดตั้ง' },
    'owned.heading': {
      en: 'What running it yourself actually means',
      th: 'การติดตั้งเองหมายถึงอะไรบ้าง',
    },
    'install.heading': { en: 'Running in three steps', th: 'เริ่มใช้งานได้ในสามขั้นตอน' },
  },
};

// Substituted when a string carries a number, so "7 days" follows the server
// rather than being typed into the copy.
function interpolate(text, values) {
  if (!values) return text;
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ));
}

function allEntries() {
  const list = [];
  for (const [scope, strings] of Object.entries(CONTENT)) {
    for (const [key, value] of Object.entries(strings)) {
      list.push({ scope, key, en: value.en || '', th: value.th || '' });
    }
  }
  return list;
}

/**
 * Every platform string, as a flat map of key to the requested language.
 *
 * Falls back to English, and then to the built-in copy, so a missing or emptied
 * string degrades to something readable rather than rendering a blank on a legal
 * page.
 */
function strings(lang = 'en', values = null) {
  const wantTh = lang === 'th';
  const out = {};
  for (const entry of allEntries()) {
    const text = wantTh ? (entry.th || entry.en) : (entry.en || entry.th);
    out[entry.key] = interpolate(text, values);
  }
  return out;
}

function text(key, lang = 'en', values = null) {
  const entry = allEntries().find((e) => e.key === key);
  if (!entry) return '';
  return interpolate(want(lang) ? (entry.th || entry.en) : (entry.en || entry.th), values);
}
function want(lang) { return lang === 'th'; }

// ---------------------------------------------------------------- editing

// Saved edits live in the platform's own collection, seeded from the built-in
// copy on first read. Kept as a table rather than as a patch object so the
// editor can show exactly which strings have been changed and which have not.
function platformStrings() {
  const table = coll('platformContent') || [];
  const saved = new Map();
  for (const row of table) saved.set(`${row.scope}:${row.key}`, row);
  const out = {};
  for (const entry of allEntries()) {
    const row = saved.get(`${entry.scope}:${entry.key}`);
    out[entry.key] = {
      ...entry,
      en: row && row.en !== undefined && row.en !== null ? row.en : entry.en,
      th: row && row.th !== undefined && row.th !== null ? row.th : entry.th,
      edited: Boolean(row),
    };
  }
  return out;
}

function saveStrings(scope, updates) {
  const table = coll('platformContent') || [];
  const allowed = new Set(allEntries().filter((e) => e.scope === scope).map((e) => e.key));
  for (const [key, value] of Object.entries(updates || {})) {
    if (!allowed.has(key)) continue;
    const id = `${scope}:${key}`;
    let row = table.find((r) => r.id === id);
    if (!row) {
      row = { id, scope, key, en: '', th: '', createdAt: now() };
      table.push(row);
    }
    if (value && value.en !== undefined) row.en = String(value.en).slice(0, 4000);
    if (value && value.th !== undefined) row.th = String(value.th).slice(0, 4000);
    row.updatedAt = now();
  }
  touch();
  return platformStrings();
}

function resetStrings(scope) {
  const table = coll('platformContent') || [];
  for (let i = table.length - 1; i >= 0; i -= 1) {
    if (table[i].scope === scope) table.splice(i, 1);
  }
  touch();
  return platformStrings();
}

module.exports = {
  CONTENT, UI_STRINGS, strings, text, platformStrings, saveStrings, resetStrings,
  allEntries, scopes: Object.keys(CONTENT),
};