// Simple notification/modal utility for Zorexium Labs
(function(){
  const container = document.createElement('div');
  container.id = 'zrx-notifications';
  container.style.position = 'fixed';
  container.style.right = '16px';
  container.style.bottom = '16px';
  container.style.zIndex = '9999';
  document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(container));

  function showNotification(message, type='info', timeout=3500) {
    const el = document.createElement('div');
    el.className = 'zrx-notification zrx-' + type;
    el.style.marginTop = '8px';
    el.style.background = type==='error' ? '#7f1d1d' : type==='success' ? '#064e3b' : '#111827';
    el.style.color = '#fff';
    el.style.padding = '10px 14px';
    el.style.borderRadius = '8px';
    el.style.boxShadow = '0 6px 18px rgba(0,0,0,0.4)';
    el.style.fontSize = '14px';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(()=>{ el.style.opacity = '0'; setTimeout(()=>el.remove(),300); }, timeout);
  }

  function makeModal(htmlContent, onClose) {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.left = '0'; overlay.style.top = '0'; overlay.style.right='0'; overlay.style.bottom='0';
    overlay.style.background = 'rgba(0,0,0,0.6)'; overlay.style.zIndex='10000';
    overlay.style.display='flex'; overlay.style.alignItems='center'; overlay.style.justifyContent='center';
    const box = document.createElement('div');
    box.style.background='#0b1220'; box.style.color='#e6eef6'; box.style.padding='20px'; box.style.borderRadius='12px'; box.style.minWidth='320px'; box.innerHTML = htmlContent;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return { overlay, box, close: ()=>{ overlay.remove(); onClose && onClose(); } };
  }

  function showConfirm(message, yesCb, noCb) {
    const { overlay, box, close } = makeModal(`
      <h3 style="margin:0 0 10px">Confirm</h3>
      <p style="margin:0 0 16px">${message}</p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="zrx-no" style="padding:8px 12px;border-radius:6px">No</button>
        <button id="zrx-yes" style="padding:8px 12px;border-radius:6px;background:#10b981;color:#fff">Yes</button>
      </div>`);
    box.querySelector('#zrx-yes').addEventListener('click', ()=>{ close(); yesCb && yesCb(); });
    box.querySelector('#zrx-no').addEventListener('click', ()=>{ close(); noCb && noCb(); });
  }

  function showPrompt(title, fields, submitCb, cancelCb) {
    let inputsHtml = fields.map(f=>{
      return `<div style="margin-bottom:10px"><label style="display:block;margin-bottom:6px">${f.label}</label><input id="zrx-${f.id}" type="${f.type||'text'}" placeholder="${f.placeholder||''}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #223"/></div>`;
    }).join('');
    const { overlay, box, close } = makeModal(`
      <h3 style="margin:0 0 10px">${title}</h3>
      <div>${inputsHtml}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="zrx-cancel" style="padding:8px 12px;border-radius:6px">Cancel</button>
        <button id="zrx-submit" style="padding:8px 12px;border-radius:6px;background:#06b6d4;color:#08273b">Submit</button>
      </div>`);
    box.querySelector('#zrx-submit').addEventListener('click', ()=>{
      const values = {};
      fields.forEach(f=> values[f.id] = box.querySelector('#zrx-'+f.id).value);
      close(); submitCb && submitCb(values);
    });
    box.querySelector('#zrx-cancel').addEventListener('click', ()=>{ close(); cancelCb && cancelCb(); });
  }

  window.ZrxNotify = { showNotification, showConfirm, showPrompt };
})();
