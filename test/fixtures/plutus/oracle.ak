use aiken/collection/list
use aiken/interval
use cardano/transaction.{OutputReference, Transaction}

// Accepts every spend.
validator always_succeeds {
  spend(_d: Option<Data>, _r: Data, _o: OutputReference, _tx: Transaction) {
    True
  }

  else(_) {
    True
  }
}

// Rejects every spend, with a trace.
validator always_fails {
  spend(_d: Option<Data>, _r: Data, _o: OutputReference, _tx: Transaction) {
    trace @"oracle: always fails"
    fail
  }

  else(_) {
    fail
  }
}

// The inline datum is a key hash that must be among the required signers.
validator needs_signer {
  spend(d: Option<ByteArray>, _r: Data, _o: OutputReference, tx: Transaction) {
    expect Some(pkh) = d
    list.has(tx.extra_signatories, pkh)?
  }

  else(_) {
    fail
  }
}

// The inline datum is a POSIX time in ms, the validity range must start at or after it.
validator after_deadline {
  spend(d: Option<Int>, _r: Data, _o: OutputReference, tx: Transaction) {
    expect Some(deadline) = d
    interval.is_entirely_after(tx.validity_range, deadline - 1)?
  }

  else(_) {
    fail
  }
}

// The redeemer n makes the script count down from n, to burn a known budget.
validator burn {
  spend(_d: Option<Data>, r: Int, _o: OutputReference, _tx: Transaction) {
    countdown(r)
  }

  else(_) {
    fail
  }
}

fn countdown(n: Int) -> Bool {
  if n <= 0 {
    True
  } else {
    countdown(n - 1)
  }
}
