import type { AnchorHTMLAttributes, MouseEvent } from "react"

import { appLinkNavigationPath, navigateApp } from "@/app-route"

type AppLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }

// 保留真实 <a href>（复制链接、中键/修饰键新开），普通左键点击走 SPA 内导航。
export function AppLink({ onClick, ...props }: AppLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    const path = appLinkNavigationPath(event, {
      href: props.href,
      target: props.target,
      download: props.download !== undefined && props.download !== false,
    }, window.location.origin)
    if (!path) return
    event.preventDefault()
    navigateApp(path)
  }
  return <a {...props} onClick={handleClick} />
}
