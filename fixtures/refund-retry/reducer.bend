import Base
import ./domain.bend as D

# Pure refund retry decision: two attempts, then a terminal failure.
def step(+s: D.RetryState, e: D.RetryEvent) -> D.RetryStep:
  match s e:
    case D.SReady{} D.EStart{}:
      D.RetryStep{D.SAttempt1{}, D.RunAttempt{D.A1{}}}
    case D.SAttempt1{} D.ESucceeded{D.A1{}}:
      D.RetryStep{D.SSucceeded{}, D.NoEffect{}}
    case D.SAttempt1{} D.EFailed{D.A1{}}:
      D.RetryStep{D.SAttempt2{}, D.RunAttempt{D.A2{}}}
    case D.SAttempt2{} D.ESucceeded{D.A2{}}:
      D.RetryStep{D.SSucceeded{}, D.NoEffect{}}
    case D.SAttempt2{} D.EFailed{D.A2{}}:
      D.RetryStep{D.SFailed{}, D.NoEffect{}}
    case _ _:
      D.RetryStep{s, D.NoEffect{}}
