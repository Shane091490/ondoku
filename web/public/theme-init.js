// Applies the saved theme before first paint (external file because the CSP forbids inline scripts).
try {
  var p = JSON.parse(localStorage.getItem('readlog.reader') || '{}');
  if (p.theme) document.documentElement.setAttribute('data-theme', p.theme);
} catch (e) { /* storage blocked */ }
