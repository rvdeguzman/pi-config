resource "aws_cloudfront_distribution" "edge" {
  enabled = true
  origin {
    domain_name = aws_lb.api.dns_name
    origin_id   = "meridian-api"
  }
  default_cache_behavior {
    target_origin_id = "meridian-api"
    cached_methods   = ["GET", "HEAD"]
    min_ttl          = 0
    default_ttl      = 60
  }
}
