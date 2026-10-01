import React, { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { ShieldCheck, Download, Mail, Clock, Database } from 'lucide-react';

// The privacy notice a customer is entitled to before their data is collected,
// and the record of what the shop says it does with it. Served in English and
// Thai because a notice the customer cannot read is not a notice.
export default function Privacy() {
  // The notice is public and sits outside the signed-in language provider, so
  // it keeps its own choice and remembers it per browser.
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem('pos_privacy_lang') === 'en' ? 'en' : 'th'; } catch (e) { return 'th'; }
  });
  const [notice, setNotice] = useState(null);
  const [noticeError, setNoticeError] = useState(false);
  // The page's own wording, owned by the platform and edited at /platform.
  const [copy, setCopy] = useState({});

  function toggleLang() {
    const next = lang === 'th' ? 'en' : 'th';
    setLang(next);
    try { localStorage.setItem('pos_privacy_lang', next); } catch (e) {}
  }

  useEffect(() => {
    // The public notice endpoint resolves the store itself, so this works for a
    // visitor who has never signed in and sends no store header. The older
    // tenant-scoped route answered 400 here, which left the page blank with the
    // controller's name and contact missing, exactly where they must not be.
    get('/public/privacy-notice')
      .then((d) => { if (d && d.controller) setNotice(d); else setNoticeError(true); })
      .catch(() => setNoticeError(true));
  }, []);

  const thai = lang === 'th';

  // The wording of the page itself, owned and edited at /platform. Fetched per
  // language rather than both at once, so a half-translated notice cannot put
  // English into a Thai document by accident.
  useEffect(() => {
    let live = true;
    get(`/platform-content/${lang}`)
      .then((d) => { if (live) setCopy(d || {}); })
      .catch(() => { if (live) setCopy({}); });
    return () => { live = false; };
  }, [lang]);

  // Every string goes through here. A missing or emptied edit falls back to the
  // wording that ships with the software, so the page degrades to something
  // readable rather than a blank heading on a legal document.
  const c = (key, fallback) => copy[key] || fallback;

  return (
    <div className="privacy">
      <div className="privacy-inner">
        <div className="privacy-head">
          <div>
            <span className="eyebrow">PDPA · พ.ร.บ. 2562</span>
            <h1>{c('title', thai ? 'นโยบายความเป็นส่วนตัว' : 'Privacy notice')}</h1>
            <p className="muted">
              {thai
                ? 'เอกสารฉบับนี้อธิบายว่าร้านเก็บข้อมูลส่วนบุคคลของคุณอย่างไร ตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562'
                : 'How this shop handles your personal data under the Personal Data Protection Act B.E. 2562 (PDPA).'}
            </p>
          </div>
          <div className="privacy-head-actions">
            <button className="btn sm" onClick={toggleLang}>
              {thai ? 'English' : 'ไทย'}
            </button>
            <a className="btn sm" href="/">← {thai ? 'หน้าแรก' : 'Home'}</a>
          </div>
        </div>

        {!notice ? (
          noticeError ? (
            <p className="muted">
              {c('loadFailed', thai ? 'ยังเปิดหน้านโยบายความเป็นส่วนตัวนี้ไม่ได้ กรุณาติดต่อร้านโดยตรง' : 'This privacy notice could not be loaded. Please contact the shop directly.')}
            </p>
          ) : <p className="muted">…</p>
        ) : (
          <>
            {(noticeError || !notice.controller.legalName || !notice.controller.contactEmail) && (
              <p className="privacy-warning">
                {c('controllerWarning', thai ? 'ร้านยังไม่ได้กรอกชื่อทางกฎหรืออีเมลติดต่อเรื่องข้อมูลส่วนบุคคลให้ครบ กรุณาตั้งค่าในหน้าตั้งค่าร้าน' : 'This shop has not filled in its legal name and privacy contact yet. Set them in the shop settings.')}
              </p>
            )}
            <section className="privacy-block">
              <h2>{c('controller.heading', thai ? 'ผู้ควบคุมข้อมูล' : 'Who is responsible')}</h2>
              <p>
                {c('controller.body', thai ? 'ข้อมูลของคุณถูกเก็บโดยร้านนี้ในฐานะผู้ควบคุมข้อมูลส่วนบุคคล' : 'Your data is held by this shop as the data controller.')}
              </p>
              <dl className="privacy-facts">
                <div>
                  <dt>{c('controller.legalNameLabel', thai ? 'ชื่อทางกฎ' : 'Legal name')}</dt>
                  <dd>{notice.controller.legalName || (thai ? 'ยังไม่ได้ระบุ' : 'Not set yet')}</dd>
                </div>
                <div>
                  <dt>{c('controller.contactLabel', thai ? 'อีเมลติดต่อเรื่องข้อมูลส่วนบุคคล' : 'Privacy contact')}</dt>
                  <dd>
                    {notice.controller.contactEmail
                      ? <a href={`mailto:${notice.controller.contactEmail}`}>{notice.controller.contactEmail}</a>
                      : (thai ? 'ยังไม่ได้ระบุ' : 'Not set yet')}
                  </dd>
                </div>
                <div>
                  <dt>{c('controller.retentionLabel', thai ? 'ระยะเวลาการเก็บรักษา' : 'How long we keep it')}</dt>
                  <dd>
                    {notice.retentionDays > 0
                      ? (thai
                        ? `${notice.retentionDays} วัน นับจากวันที่สมัคร`
                        : `${notice.retentionDays} days from the date you joined`)
                      : (thai ? 'จนกว่าคุณจะขอลบ' : 'Until you ask us to delete it')}
                  </dd>
                </div>
                {(notice.controller.address || '') ? (
                  <div>
                    <dt>{c('controller.addressLabel', thai ? 'ที่อยู่' : 'Address')}</dt>
                    <dd>{notice.controller.address}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>{c('controller.versionLabel', thai ? 'เวอร์ชันนโยบาย' : 'Notice version')}</dt>
                  <dd>{notice.version}</dd>
                </div>
              </dl>
            </section>

            <section className="privacy-block">
              <h2>{c('collect.heading', thai ? 'เราเก็บข้อมูลอะไร และเพื่ออะไร' : 'What we collect, and why')}</h2>
              <p>
                {c('collect.body', thai ? 'เราเก็บเฉพาะข้อมูลที่จำเป็นต่อบริการที่คุณขอ ได้แก่ ชื่อ หมายเลขโทรศัพท์ อีเมล และยอดคะแนนสะสม' : 'We collect only what the service you asked for needs: your name, phone number, email address, and loyalty points. We do not collect payment card numbers, and we never sell your data.')}
              </p>
              <ul className="privacy-list">
                <li>
                  <ShieldCheck size={15} />
                  <span>
                    <b>{thai ? 'ให้บริการสมาชิก' : 'To service your membership'}</b>
                    {thai ? ' — เพื่อให้คุณใช้สิทธิ์สมาชิกและติดต่อคุณเมื่อจำเป็น' : ' — so you can use your benefits and reach you when we must'}
                  </span>
                </li>
                <li>
                  <ShieldCheck size={15} />
                  <span>
                    <b>{thai ? 'ระบบสะสมคะแนน' : 'To run the loyalty scheme'}</b>
                    {thai ? ' — เฉพาะเมื่อคุณยินยอม' : ' — only if you consent'}
                  </span>
                </li>
                <li>
                  <ShieldCheck size={15} />
                  <span>
                    <b>{thai ? 'การตลาด' : 'Marketing'}</b>
                    {thai ? ' — ข้อความโปรโมชั่น เฉพาะเมื่อคุณยินยอมและเมื่อคุณถอนยินยอมได้ทุกเมื่อ' : ' — promotions, only if you consent, and you can withdraw at any time'}
                  </span>
                </li>
              </ul>
            </section>

            <section className="privacy-block">
              <h2>{c('rights.heading', thai ? 'สิทธิของคุณ' : 'Your rights')}</h2>
              <p>
                {c('rights.body', thai ? 'คุณมีสิทธิตามพระราชบัญญัติฉบับนี้ และสามารถใช้สิทธิได้ทุกเมื่อ โดยติดต่อเราตามข้อมูลด้านบน' : 'The PDPA gives you the following rights. You can exercise any of them at any time by contacting us using the details above.')}
              </p>
              <ul className="privacy-list rights">
                {(notice.rights || []).map((r) => (
                  <li key={r.id}>
                    <Download size={15} />
                    <span><b>{r.id}</b> — {thai ? thaiRight(r.id) : r.label}</span>
                  </li>
                ))}
              </ul>
              <p className="muted">
                {c('rights.footer', thai ? 'ร้านจะตอบกลับภายในระยะเวลาที่กฎหมายกำหนด หากเราไม่สามารถปฏิบัติตาม เราจะแจ้งเหตุผลเป็นลายลักษณ์อักษร' : 'We respond within the period the law allows. If we cannot action a request we will say so in writing and explain why.')}
              </p>
            </section>

            <section className="privacy-block">
              <h2>{c('security.heading', thai ? 'ความปลอดภัยและการเก็บรักษา' : 'Security and storage')}</h2>
              <p>
                {c('security.body', thai ? 'ข้อมูลถูกเข้ารหัสรหัสผ่านด้วยวิธีที่เหมาะสม และเก็บไว้บนเซิร์ฟเวอร์ของเรา เราจำกัดการเข้าถึงเฉพาะพนักงานที่จำเป็นต้องรู้ และบันทึกการเข้าถึงข้อมูลส่วนบุคคลไว้ในบันทึกการตรวจสอบ' : 'Passwords are stored as salted hashes, the data file is not reachable from the internet, access is limited to staff who need it, and every access to, export of, or deletion of personal data is written to the audit log.')}
              </p>
              <p className="muted">
                {c('security.breach', thai ? 'หากเกิดเหตุละเลยข้อมูล เราจะแจ้งสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคลตามกำหนดกฎหมาย' : 'If personal data is breached we will notify the PDPC and any affected customer as the law requires.')}
              </p>
            </section>

            <section className="privacy-block" id="storage">
              <h2>{c('storage.heading', thai ? 'คุกกี้และข้อมูลในเบราว์เซอร์' : 'Cookies and browser storage')}</h2>
              <p>
                {c('cookies.body', thai ? 'เราไม่ตั้งคุกกี้เลย' : 'We set no cookies.')}
              </p>
            </section>

            <section className="privacy-block privacy-contact">
              <div className="privacy-contact-row">
                <Mail size={18} />
                <div>
                  <strong>{c('contact.heading', thai ? 'ติดต่อเรา' : 'Contact us')}</strong>
                  <p>
                    {notice.controller.contactEmail
                      ? <a href={`mailto:${notice.controller.contactEmail}`}>{notice.controller.contactEmail}</a>
                      : (thai ? 'ติดต่อทางร้าน' : 'Ask any member of staff')}
                  </p>
                </div>
              </div>
              <div className="privacy-contact-row">
                <Clock size={18} />
                <div>
                  <strong>{c('contact.retentionHeading', thai ? 'ระยะเวลาการเก็บรักษา' : 'Retention')}</strong>
                  <p>
                    {notice.retentionDays > 0
                      ? (thai ? `${notice.retentionDays} วัน` : `${notice.retentionDays} days`)
                      : (thai ? 'จนกว่าคุณจะขอลบ' : 'Until you ask us to delete it')}
                  </p>
                </div>
              </div>
              <div className="privacy-contact-row">
                <Database size={18} />
                <div>
                  <strong>{c('contact.versionHeading', thai ? 'เวอร์ชันเอกสาร' : 'Document version')}</strong>
                  <p>{notice.version}</p>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function thaiRight(id) {
  return {
    access: 'ขอสำเนาข้อมูลของคุณ',
    correct: 'ขอแก้ไขข้อมูลที่ไม่ถูกต้อง',
    erase: 'ขอลบข้อมูลของคุณ',
    withdraw: 'ถอนยินยอม',
    object: 'คัดค้านการประมวลผลข้อมูล',
  }[id] || id;
}
