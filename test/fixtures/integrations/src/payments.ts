import Stripe from 'stripe'
import { verifyToken } from '@clerk/backend'

const stripe = new Stripe('sk_test_fixture')

export async function refund(token: string, charge: string): Promise<void> {
  await verifyToken(token, {})
  await stripe.refunds.create({ charge })
}
