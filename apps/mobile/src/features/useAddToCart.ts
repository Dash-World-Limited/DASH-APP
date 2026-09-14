/**
 * Adding to the cart, including the one case that needs a question.
 *
 * A cart holds one shop's items, because a DASH order has one vendor. When a
 * customer adds from a second shop, the choice is theirs — start a new cart,
 * or keep the one they have — and it is asked with a native dialog, never
 * decided for them by replacing the cart or dropping the tap.
 */

import { Alert } from 'react-native';

import { knownMerchantName } from '../data/useCatalog';
import { useCart } from './CartProvider';

export function useAddToCart(): (item: {
  merchantSlug: string;
  productId: string;
  quantity: number;
  options?: Record<string, string>;
  onAdded?: () => void;
}) => void {
  const { cart, dispatch, refusalFor } = useCart();

  return ({ onAdded, ...item }) => {
    if (!refusalFor(item.merchantSlug)) {
      dispatch({ type: 'add', ...item });
      onAdded?.();
      return;
    }
    const current = knownMerchantName(cart.merchantSlug) ?? 'another shop';
    const next = knownMerchantName(item.merchantSlug) ?? 'this shop';
    Alert.alert(
      'Start a new cart?',
      `Your cart has items from ${current}. A DASH order comes from one shop, so adding from ${next} starts a new cart.`,
      [
        { text: 'Keep current cart', style: 'cancel' },
        {
          text: 'Start new cart',
          style: 'destructive',
          onPress: () => {
            dispatch({ type: 'replaceWith', ...item });
            onAdded?.();
          },
        },
      ],
    );
  };
}
