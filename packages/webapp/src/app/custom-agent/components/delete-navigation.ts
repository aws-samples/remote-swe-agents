type DeleteSuccessRouter = {
  refresh: () => void;
};

type DeleteSuccessNavigationOptions = {
  onDeleted?: () => void;
  onSuccess?: () => void;
};

/**
 * Navigation performed after a custom agent is successfully deleted.
 *
 * When `onDeleted` is provided (e.g. the detail page, which owns the route of
 * the agent being deleted), the caller is responsible for navigating away.
 * Refreshing the current route would re-render the now-deleted agent's
 * force-dynamic page and trigger notFound() -> 404, so we must NOT call
 * router.refresh() in that case.
 *
 * When `onDeleted` is absent (e.g. sub-agent deletion, where the parent detail
 * page still exists), we keep the historical behavior: refresh the current
 * route and invoke `onSuccess`.
 */
export function runDeleteSuccessNavigation(
  router: DeleteSuccessRouter,
  { onDeleted, onSuccess }: DeleteSuccessNavigationOptions
): void {
  if (onDeleted) {
    onDeleted();
    return;
  }

  router.refresh();
  onSuccess?.();
}
