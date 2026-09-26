import type { MetadataRoute } from 'next'

/** Everything here is public by design, so crawlers get all of it; without this, /robots.txt 404s. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/' } }
}
