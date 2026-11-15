// Fablehop pixel logos. "#" = accent, "o" = text color, "." = empty.
// Shared by the popup and the on-page panel.
var fhLogo = (function () {
  const GRIDS = {
    fablehop: [
      ".##...##.",
      ".#o#.#o#.",
      ".#o#.#o#.",
      ".#o#.#o#.",
      ".#######.",
      "#########",
      "##o###o##",
      "#########",
      "###ooo###",
      ".#######.",
      ".##...##.",
    ],
    // two arrows chasing each other, with a gap knocked out of the loop
    unrepost: [
      "......#....",
      ".ooooo##...",
      ".o....#....",
      ".o.........",
      "...........",
      ".........o.",
      "....#....o.",
      "...##ooooo.",
      "....#......",
    ],
  };

  function svg(name, size, colors) {
    const grid = GRIDS[name];
    const c = Object.assign({ "#": "#4d5cff", o: "#ecebf3" }, colors);
    const w = grid[0].length;
    const h = grid.length;
    let rects = "";
    grid.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (c[ch]) rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c[ch]}"/>`;
      });
    });
    const height = size;
    const width = Math.round((size * w) / h);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${width}" height="${height}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
  }

  return { svg };
})();
