import { redirect } from 'next/navigation';

/**
 * Payments and refunds are one screen with two tabs now, so this route
 * forwards rather than duplicating it. The old address stays valid for anyone
 * who bookmarked it and for links elsewhere in the app.
 *
 * The role gate does NOT move here. This route was wrapped in
 * `<RoleRoute allow={CAN.manageRefunds}>`; the destination applies the same
 * check to the tab itself (see `canManageRefunds` in the payments page), so an
 * employee following this link lands on Transactions with no refunds tab
 * rather than on a permissions error for a screen that no longer exists.
 */
export default function RefundsPage() {
  redirect('/app/payments?tab=refunds');
}
