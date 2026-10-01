// Runs before first paint so the chosen theme never flashes. Kept tiny and dependency free.
(function () {
  try {
    var t = localStorage.getItem('circle.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    if (localStorage.getItem('circle.density') === 'compact') document.documentElement.setAttribute('data-density', 'compact');
  } catch (e) { /* storage blocked: follow the system */ }
})();
