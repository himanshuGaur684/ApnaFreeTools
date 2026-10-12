// Home page: filters the tool cards as you type in the search box.
(function () {
  'use strict';

  const search = document.getElementById('toolSearch');
  const groups = Array.from(document.querySelectorAll('.home-group'));

  search.addEventListener('input', () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    groups.forEach((group) => {
      let any = false;
      group.querySelectorAll('.tool-card').forEach((card) => {
        const match = words.every((word) => card.dataset.search.includes(word));
        card.hidden = !match;
        any = any || match;
        if (match) shown++;
      });
      group.hidden = !any;
    });
    document.getElementById('toolSearchEmpty').hidden = shown > 0;
  });
})();
