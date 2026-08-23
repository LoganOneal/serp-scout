export const HHT_GLOBAL_KEYWORD_PAGE_SIZE = 100

export function resolveHhtKeywordPage(
  requestedPage: number | undefined,
  totalRows: number,
  pageSize = HHT_GLOBAL_KEYWORD_PAGE_SIZE,
) {
  const safePageSize = Math.max(1, Math.trunc(pageSize))
  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalRows) / safePageSize))
  const integerPage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage ?? 1) : 1
  const page = Math.min(Math.max(1, integerPage), totalPages)

  return {
    page,
    pageSize: safePageSize,
    totalPages,
    totalRows: Math.max(0, totalRows),
    offset: (page - 1) * safePageSize,
  }
}
