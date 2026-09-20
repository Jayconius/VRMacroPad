// Grid geometry shared by the server (validation) and the UI (drag/resize).
// Written as a UMD so it loads via <script> in the browser and require() in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Grid = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  function inBounds(page, r) {
    return r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= page.cols && r.y + r.h <= page.rows;
  }

  // True when rect r can sit on the page without leaving it or touching another button.
  function fits(page, r, ignoreId) {
    if (!inBounds(page, r)) return false;
    return !page.buttons.some((b) => b.id !== ignoreId && overlaps(r, b));
  }

  // First free top-left position for a w x h button, scanning row by row.
  function findFreeSpot(page, w, h, ignoreId) {
    for (let y = 0; y + h <= page.rows; y++) {
      for (let x = 0; x + w <= page.cols; x++) {
        if (fits(page, { x, y, w, h }, ignoreId)) return { x, y };
      }
    }
    return null;
  }

  // Smallest cols/rows the page can shrink to without cutting a button off.
  function minPageSize(page) {
    let cols = 1;
    let rows = 1;
    for (const b of page.buttons) {
      cols = Math.max(cols, b.x + b.w);
      rows = Math.max(rows, b.y + b.h);
    }
    return { cols, rows };
  }

  return { overlaps, inBounds, fits, findFreeSpot, minPageSize };
});
