document.addEventListener('DOMContentLoaded', function(){
  // Set all internal anchor links to open in new tab
  document.querySelectorAll('a').forEach(function(a){
    // skip anchors that already target something specific (like anchors to same page with href starting '#')
    try {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('#') && href.trim() !== '') a.setAttribute('target', '_blank');
    } catch(e){}
  });
});
