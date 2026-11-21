import Base
import ./domain.bend as D
import ./LAWS.bend as Laws

# The domain is finite: split every state/event pair and let both sides compute.
def Laws.conforms(s, e):
  match s e:
    case D.SReady{} D.EStart{}:
      {==}
    case D.SReady{} D.ESucceeded{D.A1{}}:
      {==}
    case D.SReady{} D.ESucceeded{D.A2{}}:
      {==}
    case D.SReady{} D.ESucceeded{D.A3{}}:
      {==}
    case D.SReady{} D.EFailed{D.A1{}}:
      {==}
    case D.SReady{} D.EFailed{D.A2{}}:
      {==}
    case D.SReady{} D.EFailed{D.A3{}}:
      {==}
    case D.SAttempt1{} D.EStart{}:
      {==}
    case D.SAttempt1{} D.ESucceeded{D.A1{}}:
      {==}
    case D.SAttempt1{} D.ESucceeded{D.A2{}}:
      {==}
    case D.SAttempt1{} D.ESucceeded{D.A3{}}:
      {==}
    case D.SAttempt1{} D.EFailed{D.A1{}}:
      {==}
    case D.SAttempt1{} D.EFailed{D.A2{}}:
      {==}
    case D.SAttempt1{} D.EFailed{D.A3{}}:
      {==}
    case D.SAttempt2{} D.EStart{}:
      {==}
    case D.SAttempt2{} D.ESucceeded{D.A1{}}:
      {==}
    case D.SAttempt2{} D.ESucceeded{D.A2{}}:
      {==}
    case D.SAttempt2{} D.ESucceeded{D.A3{}}:
      {==}
    case D.SAttempt2{} D.EFailed{D.A1{}}:
      {==}
    case D.SAttempt2{} D.EFailed{D.A2{}}:
      {==}
    case D.SAttempt2{} D.EFailed{D.A3{}}:
      {==}
    case D.SAttempt3{} D.EStart{}:
      {==}
    case D.SAttempt3{} D.ESucceeded{D.A1{}}:
      {==}
    case D.SAttempt3{} D.ESucceeded{D.A2{}}:
      {==}
    case D.SAttempt3{} D.ESucceeded{D.A3{}}:
      {==}
    case D.SAttempt3{} D.EFailed{D.A1{}}:
      {==}
    case D.SAttempt3{} D.EFailed{D.A2{}}:
      {==}
    case D.SAttempt3{} D.EFailed{D.A3{}}:
      {==}
    case D.SSucceeded{} D.EStart{}:
      {==}
    case D.SSucceeded{} D.ESucceeded{D.A1{}}:
      {==}
    case D.SSucceeded{} D.ESucceeded{D.A2{}}:
      {==}
    case D.SSucceeded{} D.ESucceeded{D.A3{}}:
      {==}
    case D.SSucceeded{} D.EFailed{D.A1{}}:
      {==}
    case D.SSucceeded{} D.EFailed{D.A2{}}:
      {==}
    case D.SSucceeded{} D.EFailed{D.A3{}}:
      {==}
    case D.SFailed{} D.EStart{}:
      {==}
    case D.SFailed{} D.ESucceeded{D.A1{}}:
      {==}
    case D.SFailed{} D.ESucceeded{D.A2{}}:
      {==}
    case D.SFailed{} D.ESucceeded{D.A3{}}:
      {==}
    case D.SFailed{} D.EFailed{D.A1{}}:
      {==}
    case D.SFailed{} D.EFailed{D.A2{}}:
      {==}
    case D.SFailed{} D.EFailed{D.A3{}}:
      {==}
