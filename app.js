

// Google login handler
document.addEventListener('click', async function(e){
  const link=e.target.closest('#googleLogin');
  if(!link)return;
  e.preventDefault();
  try{
    const result=await sb.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin+window.location.pathname}});
    if(result.error) throw result.error;
  }catch(err){console.error('Google login error',err);flashMessage('تعذر فتح تسجيل الدخول عبر Google');}
});
