import Heap from 'qheap';
import { WrappedTransaction } from '@gxchain2/tx';
import { FunctionalMap } from '@gxchain2/utils';

export class PendingTxMap {
  private heap = new Heap({ comparBefore: (a: WrappedTransaction, b: WrappedTransaction) => a.transaction.gasPrice.gt(b.transaction.gasPrice) });
  private txs = new FunctionalMap<Buffer, WrappedTransaction[]>((a: Buffer, b: Buffer) => {
    if (a.length < b.length) {
      return -1;
    }
    if (a.length > b.length) {
      return 1;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) {
        return -1;
      }
      if (a[i] > b[i]) {
        return 1;
      }
    }
    return 0;
  });

  push(sender: Buffer, sortedTxs: WrappedTransaction[]) {
    if (sortedTxs.length > 0) {
      this.heap.push(sortedTxs.slice(0, 1)[0]);
      if (sortedTxs.length > 1) {
        this.txs.set(sender, sortedTxs.slice(1));
      }
    }
  }

  peek(): WrappedTransaction | undefined {
    return this.heap.peek();
  }

  shift() {
    const tx: WrappedTransaction | undefined = this.heap.remove();
    if (tx) {
      const sender = tx.transaction.getSenderAddress().buf;
      const nextTx = this.txs.get(sender);
      if (nextTx && nextTx.length > 0) {
        this.heap.push(nextTx.shift());
        if (nextTx?.length === 0) {
          this.txs.delete(sender);
        }
      }
    }
  }

  pop() {
    this.heap.remove();
  }
}