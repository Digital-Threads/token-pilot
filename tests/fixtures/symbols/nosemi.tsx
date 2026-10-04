import * as React from "react"

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex", className)}
    {...props}
  />
)
SheetFooter.displayName = "SheetFooter"

const handleTabClick = (groupId: string) => () => setGroupId(groupId)

const chained = items
  .map((x) => x * 2)
  .filter(Boolean)

const routes = [
  { path: "/" },
]

const withSemi = build(
  1,
);

function after() {
  return 1
}

export { SheetFooter, handleTabClick, chained, routes, withSemi, after }
