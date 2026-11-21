import Base

# Shared finite domain for the refund retry reducer. The verifier replaces this
# file with one generated from the approved graph, so the checked input space
# always comes from the approval, not from the candidate.

type RetryAttempt is Data:
  A1{}
  A2{}
  A3{}

type RetryState is Data:
  SReady{}
  SAttempt1{}
  SAttempt2{}
  SAttempt3{}
  SSucceeded{}
  SFailed{}

type RetryEvent is Data:
  EStart{}
  ESucceeded{n: RetryAttempt}
  EFailed{n: RetryAttempt}

type RetryEffect is Data:
  NoEffect{}
  RunAttempt{n: RetryAttempt}

type RetryStep is Data:
  RetryStep{state: RetryState, effect: RetryEffect}
