// The 9×9 board. Cells are static; tokens are absolutely positioned and keyed
// by id, so a move slides the token to its new cell and a capture fades it out.

import { el, icon } from './ui.js';

const OTT = window.OTT;

export class Board {
  constructor(root) {
    this.root = root;
    this.tokenEls = new Map();
    this.cellEls = new Map();
    this.marked = [];

    const cols = el('div', { class: 'board-cols', 'aria-hidden': 'true' });
    for (let c = 1; c <= OTT.SIZE; c++) cols.append(el('span', {}, c));
    const rows = el('div', { class: 'board-rows', 'aria-hidden': 'true' });
    for (const r of OTT.ROWS) rows.append(el('span', {}, r));

    const cells = el('div', { class: 'cells' });
    for (const name of OTT.allCells()) {
      const { row, col } = OTT.coords(name);
      const classes = ['cell'];
      if ((row + col) % 2) classes.push('alt');
      if (OTT.HOME_ROWS[1].includes(name[0])) classes.push('home1');
      if (OTT.HOME_ROWS[2].includes(name[0])) classes.push('home2');
      const goalOf = name === OTT.TARGETS[1] ? 1 : name === OTT.TARGETS[2] ? 2 : 0;
      if (goalOf) classes.push(`goal${goalOf}`);
      const title = goalOf ? `${name}: ${goalOf === 1 ? 'Red' : 'Blue'}'s goal` : name;
      const cell = el('div', { class: classes.join(' '), title, dataset: { cell: name } });
      if (goalOf) cell.append(icon('target', 'goal'));
      cells.append(cell);
      this.cellEls.set(name, cell);
    }

    this.tokenLayer = el('div', { class: 'tokens' });
    this.board = el('div', { class: 'board', role: 'img', 'aria-label': 'Game board' }, cells, this.tokenLayer);
    root.replaceChildren(el('div', { class: 'board-wrap' }, cols, rows, this.board));
  }

  /** Removes every token, e.g. when switching to another match. */
  clear() {
    this.tokenLayer.replaceChildren();
    this.tokenEls.clear();
    this._unmark();
  }

  /**
   * Shows `tokens` (an array of { id, owner, type, cell }). `last` is the move
   * that led here, highlighted on the board. With animate=false everything
   * jumps into place, which suits big jumps in the replay.
   */
  render(tokens, last, animate = true) {
    this.board.classList.toggle('still', !animate);
    const alive = new Set();

    for (const token of tokens) {
      alive.add(token.id);
      let node = this.tokenEls.get(token.id);
      if (!node) {
        node = el('div', { class: `token p${token.owner}` }, el('div', { class: 'chip' }, icon(token.type)));
        this.tokenEls.set(token.id, node);
        this.tokenLayer.append(node);
      }
      this._place(node, token.cell);
      node.classList.remove('gone');
      node.classList.toggle('moved', Boolean(last && last.id === token.id));
      node.title = `${token.owner === 1 ? 'Red' : 'Blue'} ${token.type} on ${token.cell}`;
    }

    for (const [id, node] of this.tokenEls) {
      if (alive.has(id)) continue;
      // An attacker that lost charges into the cell before it disappears.
      if (animate && last && last.outcome === 'lose' && last.id === id) this._place(node, last.to);
      node.classList.add('gone');
      node.classList.remove('moved');
    }

    this._unmark();
    if (last) {
      this._mark(last.from, 'last-from');
      this._mark(last.to, 'last-to', `p${last.player}`);
      if (last.outcome !== 'move' && animate) this._mark(last.to, 'clash');
    }

    if (!animate) {
      // Turn transitions back on after this frame has been painted.
      requestAnimationFrame(() => requestAnimationFrame(() => this.board.classList.remove('still')));
    }
  }

  _place(node, cell) {
    const { row, col } = OTT.coords(cell);
    node.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
  }

  _mark(cell, ...classes) {
    const node = this.cellEls.get(cell);
    if (!node) return;
    if (classes.includes('clash')) {
      // Restart the animation even when the same cell clashes twice in a row.
      node.classList.remove('clash');
      void node.offsetWidth;
    }
    node.classList.add(...classes);
    this.marked.push([node, classes]);
  }

  _unmark() {
    for (const [node, classes] of this.marked) node.classList.remove(...classes);
    this.marked = [];
  }
}
