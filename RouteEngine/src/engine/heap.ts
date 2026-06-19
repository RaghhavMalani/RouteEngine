/**
 * A binary min-heap priority queue keyed by a numeric priority.
 *
 * Dijkstra repeatedly needs "the unvisited node with the smallest tentative
 * distance". A binary heap gives O(log n) insert and extract-min, which is what
 * turns Dijkstra from O(V^2) into O((V + E) log V) — the difference between
 * usable and unusable on a city-sized graph.
 *
 * DESIGN CHOICE: lazy deletion instead of decrease-key.
 * A textbook Dijkstra "decreases the key" of a node already in the queue when it
 * finds a shorter path to it. Implementing decrease-key needs the heap to track
 * each item's current index, which complicates the code. The standard, simpler
 * alternative — used here — is to just push a *new* entry with the better
 * priority and leave the old, stale one in the heap. When we pop a node we check
 * whether its distance is still current; if not, we skip it. This keeps the heap
 * trivially simple at the cost of a few extra entries, which is a great trade for
 * a readable, interview-explainable implementation.
 */
export interface HeapItem<T> {
  value: T;
  priority: number;
}

export class MinHeap<T> {
  private heap: HeapItem<T>[] = [];

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  push(value: T, priority: number): void {
    this.heap.push({ value, priority });
    this.bubbleUp(this.heap.length - 1);
  }

  /** Remove and return the item with the smallest priority, or undefined. */
  pop(): HeapItem<T> | undefined {
    const n = this.heap.length;
    if (n === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (n > 1) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    const node = this.heap[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].priority <= node.priority) break;
      this.heap[i] = this.heap[parent];
      i = parent;
    }
    this.heap[i] = node;
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length;
    const node = this.heap[i];
    while (true) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.heap[left].priority < this.heap[smallest].priority) smallest = left;
      if (right < n && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
      if (smallest === i) break;
      this.heap[i] = this.heap[smallest];
      this.heap[smallest] = node;
      i = smallest;
    }
  }
}
