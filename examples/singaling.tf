resource "aws_apigatewayv2_api" "signaling_api" {
  name = "signaling_api"
  protocol_type = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_integration" "signaling_integration" {
  api_id = aws_apigatewayv2_api.signaling_api.id
  integration_type = "AWS_PROXY"
  integration_method = "POST"
  integration_uri = aws_lambda_function.signaling_lambda_function.invoke_arn
  passthrough_behavior = "WHEN_NO_MATCH"
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "signaling_connect_route" {
  api_id    = aws_apigatewayv2_api.signaling_api.id
  route_key = "$connect"
  target = "integrations/${aws_apigatewayv2_integration.signaling_integration.id}"
}

resource "aws_apigatewayv2_route" "signaling_disconnect_route" {
  api_id    = aws_apigatewayv2_api.signaling_api.id
  route_key = "$disconnect"
  target = "integrations/${aws_apigatewayv2_integration.signaling_integration.id}"
}

resource "aws_apigatewayv2_route" "signaling_default_route" {
  api_id    = aws_apigatewayv2_api.signaling_api.id
  route_key = "$default"
  target = "integrations/${aws_apigatewayv2_integration.signaling_integration.id}"
}

resource "aws_apigatewayv2_deployment" "signaling_deployment" {
  api_id      = aws_apigatewayv2_api.signaling_api.id
  description = "production"

  triggers = {
    redeployment = sha1(join(",", tolist([
      jsonencode(aws_apigatewayv2_integration.signaling_integration),
      jsonencode(aws_apigatewayv2_route.signaling_connect_route),
      jsonencode(aws_apigatewayv2_route.signaling_disconnect_route),
      jsonencode(aws_apigatewayv2_route.signaling_default_route),
    ])))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_apigatewayv2_stage" "signaling_stage" {
  api_id = aws_apigatewayv2_api.signaling_api.id
  name = "signaling"
  auto_deploy = true

  default_route_settings {
    data_trace_enabled       = false
    detailed_metrics_enabled = false
    logging_level            = "OFF"
    throttling_rate_limit    = 10000
    throttling_burst_limit   = 5000
  }
}

resource "aws_lambda_permission" "signaling_api_gateway_lambda_invoke_permission" {
  statement_id = "AllowWebSocketInvokeFunctionFromApiGateway"
  principal = "apigateway.amazonaws.com"
  action = "lambda:InvokeFunction"
  function_name = aws_lambda_function.signaling_lambda_function.function_name

  # Grant access from any method on any resource within the signaling API Gateway in any stage (`/*/*`)
  # https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway.html
  source_arn = "${aws_apigatewayv2_api.signaling_api.execution_arn}/*/*"
}

resource "aws_lambda_function" "signaling_lambda_function" {
  function_name = "signaling_lambda_function"

  filename         = "signaling.zip"
  source_code_hash = filebase64sha256("signaling.zip")

  # "signaling" is the filename within the zip file (signaling.js) and "handler"
  # is the name of the property under which the handler function was
  # exported in that file.
  handler = "signaling.handler"

  runtime     = "nodejs14.x"
  timeout     = 60
  memory_size = 512

  environment {
    variables = {
      VERSION = "1.0.0"
    }
  }

  role = aws_iam_role.signaling_lambda_function_role.arn
}

resource "aws_iam_role" "signaling_lambda_function_role" {
  name = "signaling_lambda_function_role"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow"
    }
  ]
}
EOF
}

# Assumes you have a single ACM certificate for your domain called "cert_validation"
resource "aws_apigatewayv2_domain_name" "signaling_api_domain_name" {
  domain_name = "signaling.${var.domain}"
  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.cert_validation.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "example" {
  api_id      = aws_apigatewayv2_api.signaling_api.id
  domain_name = aws_apigatewayv2_domain_name.signaling_api_domain_name.id
  stage       = aws_apigatewayv2_stage.signaling_stage.id
}

# Assumes you have a Route53 zone for your domain called "domain_zone"
resource "aws_route53_record" "signaling" {
  name    = aws_apigatewayv2_domain_name.signaling_api_domain_name.domain_name
  type    = "A"
  zone_id = aws_route53_zone.domain_zone.id

  alias {
    name                   = aws_apigatewayv2_domain_name.signaling_api_domain_name.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.signaling_api_domain_name.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_iam_policy" "lambda_dynamodb_policy" {
  name = "lambda_dynamodb_policy"
  path = "/"

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": [
        "dynamodb:DescribeTable",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:${var.region}:*:*",
      "Effect": "Allow"
    }
  ]
}
EOF
}

resource "aws_iam_role_policy_attachment" "signaling_lambda_function_dynamodb_policy_attachment" {
  role       = aws_iam_role.signaling_lambda_function_role.name
  policy_arn = aws_iam_policy.lambda_dynamodb_policy.arn
}

resource "aws_iam_policy" "signaling_connections_policy" {
  name = "signaling_connections_policy"
  path = "/"

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "execute-api:ManageConnections"
      ],
      "Resource": [
        "${aws_apigatewayv2_api.signaling_api.execution_arn}/*"
      ]
    }
  ]
}
EOF
}

resource "aws_iam_role_policy_attachment" "signaling_connections_policy_attachment" {
  role       = aws_iam_role.signaling_lambda_function_role.name
  policy_arn = aws_iam_policy.signaling_connections_policy.arn
}
