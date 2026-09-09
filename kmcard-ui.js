/* KM Card catalog UI: display-only; no provider orders. */
(function(){
function showChat(){if(location.hash!=='#chatapps')return;document.body.classList.add('inside-section');document.querySelectorAll('[data-main-section]').forEach(x=>x.classList.toggle('section-hidden',x.id!=='chatapps'));document.querySelector('#sectionHome')?.classList.add('section-hidden');document.querySelector('#sectionBack')?.classList.remove('hidden');document.querySelector('#sectionHeading')?.replaceChildren(document.createTextNode('تطبيقات الدردشة'));}
window.addEventListener('hashchange',showChat);setInterval(showChat,300);
})();
