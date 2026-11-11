'use strict';

// Exercise the browser's real parser, box measurements, placement and router in
// Node without attaching UI listeners. Only canvas text measurement is stubbed;
// fixtures may supply exact dimensions when a particular geometry matters.
const fs = require('fs'), path = require('path');
module.exports = function load() {
  const read = name => fs.readFileSync(path.join(__dirname, '..', 'js', name + '.js'), 'utf8');
  const diagram = read('diagram');
  const geometry = diagram.slice(0, diagram.indexOf('// ─── Diagram rendering'));
  const edges = diagram.slice(diagram.indexOf('function diagramEdges('), diagram.indexOf('function dataBoxBody('));
  return new Function(`
    const state = { dataView: false, keysOnly: false, notation: 'arrows' };
    const canvas = { width: 1400, height: 1000 }, view = { s: 1 };
    const svg = { getBoundingClientRect: () => canvas };
    const document = { querySelector: () => null, createElement: () => ({ getContext: () => ({
      measureText: s => ({ width: s.length * 7 })
    }) }) };
    const localStorage = { getItem: () => null };
    const pos = {}, viewCenter = () => null, CARD_TOP = 64, CARD_BOTTOM = 56;
    ${read('model')}
    ${read('examples')}
    ${geometry}
    ${edges}
    ${read('layout')}
    return { state, canvas, view, pos, parseText, resolve, markShown, measureTable,
      arrangeAll, placeColumns, layoutEdges, diagramEdges, routeEdges, routeQuality,
      drawnQuality, simplify, compareLayout, EXAMPLES, AUTO };
  `)();
};
