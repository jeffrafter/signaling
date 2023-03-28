// https://jestjs.io/docs/dynamodb
module.exports = {
  tables: [
    {
      TableName: `Database`,
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'data', AttributeType: 'S' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 20, WriteCapacityUnits: 20 },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gs1',
          KeySchema: [
            { AttributeName: 'sk', KeyType: 'HASH' },
            { AttributeName: 'data', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      ],
    },
  ],
  basePort: 9000,
}
