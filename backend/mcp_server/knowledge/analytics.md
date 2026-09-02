# Analytics and reporting

All six endpoints are scoped by the caller's visibility, so an employee's numbers cover only
their own records. All six are cached per caller for about 30 seconds (the `X-Cache` response
header says HIT, MISS or DISABLED), and none of them is paginated.

| Tool | Access | Returns |
|---|---|---|
| `analytics_overview` | every active user | an object: enquiries, enquiriesThisMonth/LastMonth/Trend, registrationsThisMonth/LastMonth/Trend, enrollmentsThisMonth/LastMonth/Trend, registrations, enrollments, converted, conversionRate, revenueThisMonth, revenueLastMonth, revenueGrowth, pendingPayments, totalRevenue |
| `analytics_visa_pipeline` | every active user | {pipeline: [{stage, count}] for all seven stages, total} |
| `analytics_funnel` | viewAnalytics | {stages: [Enquiries at 100%, Registrations, Enrollments, Visas approved], dropOff: {enquiryToRegistration, registrationToEnrollment, enrollmentToVisa}} |
| `analytics_revenue` | viewAnalytics | {series: [{month "2026-01", label "Jan 2026", revenue, transactions, registrationFees, enrollmentFees, otherFees, commissions}]} over the last N calendar months, N from 1 to 36 |
| `analytics_branches` | viewAnalytics | a bare array of {id, name, city, staff, enquiries, registrations, enrollments, revenue, conversionRate} for the active branches in scope |
| `analytics_sources` | viewAnalytics | a bare array of {source, total, converted, conversionRate}, where source is the enquiry's stream and "Unspecified" when it is blank |

## Definitions

- A trend is the percentage change against the previous calendar month. It reads 100.0 when
  last month was zero and this month is not, which is a floor rather than a real growth rate.
- Revenue counts only payments with status Success. Commissions come from the Commission table,
  not from the enrollment's own commission figure.
- conversionRate is converted enquiries over enquiries. Every funnel rate is against the
  enquiry count, not against the previous stage, so they are comparable to each other.
- `payment_stats` is the payments screen's own aggregate: {totalRevenue, thisMonthRevenue,
  pendingAmount, transactionCount}. It is cached the same way.

## What the console adds on top

- The reports page draws three charts and exports CSV, all built in the browser from these
  same endpoints. There is no report resource and no server-side export.
- The weekly dashboard chart pins enrollments to today, because an enrollment carries only a
  future `start_date` and bucketing by it would put the work in the future.
- Platform monthly recurring revenue for a dev admin is bucketed from subscription period
  dates. It is an acknowledged approximation and should be labelled as one.

## Practical notes

- Right after a write, re-reading analytics can show the old figure for up to 30 seconds.
  Lists are always live, so verify a write by reading the record, not the totals.
- Without Redis each server worker caches separately, so two consecutive calls can disagree
  briefly. That is the cache, not the data.
- A branch manager's "company total" is their branch total, and an employee's is their own
  records. Always say whose numbers you are reporting; the endpoint will not.
- Two scope changes are not part of the cache key and lag by up to the same 30 seconds:
  accepting a record transfer, and changing which managers a head manager oversees.
