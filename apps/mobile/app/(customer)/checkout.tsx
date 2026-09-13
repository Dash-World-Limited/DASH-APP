import { ComingScreen } from '../../src/ui/ComingScreen';

/**
 * Checkout — the next checkpoint.
 *
 * Checkout, payment and order placement need three things this checkpoint
 * deliberately does not fake: a signed-in customer, the server's quote, and the
 * payment provider running in sandbox with its webhook verified. Nothing in
 * this build takes money.
 */
export default function Checkout() {
  return (
    <ComingScreen
      title="Checkout"
      icon="shield-check-outline"
      headline="Checkout is the next step"
      body="Choose a delivery address and time, pay with your DASH Wallet, a card, a transfer, USSD or on delivery, and place your order."
      waitingOn="Arrives in Checkpoint 2, with sign-in, the server's quote and Paystack in sandbox. No payment is taken in this build."
    />
  );
}
