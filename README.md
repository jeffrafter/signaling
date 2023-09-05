# Serverless Signaling Server

This is a signaling server that is intended to work with `yjs` WebRTC clients.

Connections and topic subscriptions (rooms) are stored in DynamoDB.

This is based on the the `yjs` example signaling server:

https://github.com/yjs/y-webrtc/blob/master/bin/server.js

And the following posts and demos:

- https://discuss.yjs.dev/t/serverless-signaling-server-with-aws-apigateway-dynamodb-and-lambda/680
- https://medium.com/collaborne-engineering/serverless-yjs-72d0a84326a2
- https://github.com/Collaborne/remirror-yjs-webrtc-demo

The primary differences in this implementation are around the storage.

In the `yjs` example the connections and subscriptions are maintained in memory. This is very efficient but requires an unbounded amount of memory and an always-on machine, often deployed to a VPS like fly.io.

In the serverless examples above, DynamoDB is used but each topic subscription is stored in a single document with a growing list of connections. This simplifies retrieval for publishing changes to clients but requires an expensive `scan` to handle disconnections.

Our approach uses a hash and range for subscriptions and a global secondary index for disconnection lookups. The primary actions:

- **subscribe**: add a connectionId to the TOPIC
- **unsubscribe**: remove the connectionId from the TOPIC
- **publish**: get all connectionIds associated with a TOPIC (and send)
- **disconnect**: remove the connectionId from all TOPICs

For example:

```
| pk                    | sk                       | data
|=======================|==========================|==================
| topic-TOPIC           | connection-connectionId1 | ttl could go here
| topic-TOPIC           | connection-connectionId2 |
| topic-TOPIC           | connection-connectionId3 |
| topic-TOPIC           | connection-connectionId4 |
```

Note, would could do the following optionally:

- set a TTL on a subscription, make the client periodically resubscribe or be `ttl` disconnected

In terraform this is provisioned as (fitting into the free tier):

```tf
resource "aws_dynamodb_table" "database" {
  name           = "Database"
  billing_mode   = "PROVISIONED"
  read_capacity  = 20
  write_capacity = 20
  hash_key       = "pk"
  range_key      = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "data"
    type = "S"
  }

  global_secondary_index {
    name            = "gs1"
    hash_key        = "sk"
    range_key       = "data"
    write_capacity  = 5
    read_capacity   = 5
    projection_type = "ALL"
  }

  tags = {
    Name        = "Database"
    Environment = "production"
  }
}
```

We assume the following:

- Concurrent subscribers to a topic will be generally small (usually less than 10, almost always less than 100) so all query operations will consume a single page and only 1 read capacity unit per read (0.5 eventually consistent).
- Because we are only signaling, there will be less broadcast publishes and the primary activity will be connections and disconnections. These should be fast and should avoid contention.


# Deploying

This is deployed by running

```
npm run deploy
```

It assumes a terraform setup in a neighboring `ops` folder which is custom to my setup.

You should have an `.env`:

```
NODE_ENV=development
LOCALSTACK_HOSTNAME=0.0.0.0
AWS_DYNAMODB_ENDPOINT=http://0.0.0.0:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_REGION=us-east-1
AWS_PROFILE=your-aws-profile
TABLE_NAME=Database
DEPLOY_PATH=../../path-to-your-ops-folder/ops
```

# Running this locally in development

Running this locally requires mimicking the AWS environment. I use `localstack` for this.

Run Docker Desktop. Then run:

```
npm run localstack
```

This will start the AWS clone locally but you will need to initialize the local DynamoDB:

```
./scripts/create-local-db
```

Once running, you should be able to run the server:

```
npm run start
```

Note this is running the `local.ts` version of the web socket on port 4001. This isn't the same as the production version which is relying on AWS API Gateway and Lambda, but the main handler logic is the same for both.