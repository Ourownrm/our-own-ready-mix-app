// Round 119, post-ship again, item 4 — customers and staff were seeing the
// raw database id ("Order #2381") with nothing to distinguish it from, say,
// a ticket or invoice number. This is purely a DISPLAY format: the
// underlying customer_orders.id is unchanged, delivery tickets keep their
// own separate DT-#### numbering (see plantOperator.js), and nothing about
// order lookup/sorting/APIs changes — every screen that used to render
// "#{id}" or "Order #{id}" should call this instead.
export function formatOrderNumber(id) {
  if (id === null || id === undefined || id === "") return "";
  return `ORM-${id}`;
}
