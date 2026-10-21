{
  title: 'Dewy Bank Customer API',

  # Each participant signs in as themselves, with their own Dewy Bank login and
  # nothing else. The bank_app_url connection field points to the deployed Dewy
  # Bank app; its default value is stamped before the workshop by
  # scripts/stamp_bank_app_url.py, but a facilitator can override it per-workspace
  # without touching the connector code. Everything else (Cognito region, app client
  # ID, customer API URL) is discovered from the bank app's public config.json at
  # auth time. The connector exchanges the login for a Cognito ID token, and gets a
  # new one (rediscovering the config) whenever the customer API rejects the current
  # token (ID tokens last 1 hour). The customer API scopes every route to the
  # token's customer, so nothing here can reach another customer's accounts.
  connection: {
    fields: [
      { name: 'bank_app_url', label: 'Bank app URL', optional: false,
        hint: 'CloudFront URL of the deployed Dewy Bank app',
        default: 'https://NOT_STAMPED_YET.cloudfront.net' }, # stamped before the workshop by scripts/stamp_bank_app_url.py
      { name: 'email', label: 'Dewy Bank email', optional: false,
        hint: 'The email you sign in to the Dewy Bank app with' },
      { name: 'password', label: 'Dewy Bank password', control_type: 'password', optional: false,
        hint: 'Your Dewy Bank app password' }
    ],

    authorization: {
      type: 'custom_auth',

      acquire: lambda do |connection|
        bank_app_url = connection['bank_app_url']
        if bank_app_url.nil? || bank_app_url.include?('NOT_STAMPED')
          error('This connector has not been set up for a workshop yet: ask your facilitator.')
        end
        config = get("#{bank_app_url}/config.json").response_format_json
        cognito_region      = config['region']
        user_pool_client_id = config['userPoolClientId']
        customer_api_url    = config['customerApiUrl']
        response = post("https://cognito-idp.#{cognito_region}.amazonaws.com/")
                   .headers('X-Amz-Target' => 'AWSCognitoIdentityProviderService.InitiateAuth',
                            'Content-Type' => 'application/x-amz-json-1.1')
                   .request_body({
                     AuthFlow: 'USER_PASSWORD_AUTH',
                     ClientId: user_pool_client_id,
                     AuthParameters: { USERNAME: connection['email'], PASSWORD: connection['password'] }
                   }.to_json)
                   .response_format_json
        id_token = response.dig('AuthenticationResult', 'IdToken') ||
                   response.dig('authentication_result', 'id_token')
        { id_token: id_token, customer_api_url: customer_api_url }
      end,

      refresh_on: [401],

      apply: lambda do |connection|
        headers('Authorization' => "Bearer #{connection['id_token']}")
      end
    },

    base_uri: lambda do |connection|
      connection['customer_api_url']
    end
  },

  test: lambda do |_connection|
    get('/accounts')
  end,

  # Each action is a plain call to one customer API route: no checks, no
  # reshaping. Decisions belong to the recipes that call these actions.
  actions: {
    list_accounts: {
      title: 'List my accounts',
      description: "GET /accounts: the signed-in customer's accounts",

      execute: lambda do |_connection, _input|
        get('/accounts')
      end,

      output_fields: lambda do |object_definitions|
        [{ name: 'accounts', type: 'array', of: 'object', properties: object_definitions['account'] }]
      end
    },

    list_account_transactions: {
      title: 'List account transactions',
      description: 'GET /accounts/{id}/transactions: newest first, up to 100',

      input_fields: lambda do |_object_definitions|
        [{ name: 'account_id', label: 'Account ID', optional: false }]
      end,

      execute: lambda do |_connection, input|
        get("/accounts/#{input['account_id']}/transactions")
      end,

      output_fields: lambda do |object_definitions|
        [{ name: 'transactions', type: 'array', of: 'object', properties: object_definitions['transaction'] }]
      end
    },

    create_transfer: {
      title: 'Transfer between my accounts',
      description: 'POST /transfers: between two of the signed-in customer\'s accounts',

      input_fields: lambda do |_object_definitions|
        [
          { name: 'from', label: 'From account ID', optional: false },
          { name: 'to', label: 'To account ID', optional: false },
          { name: 'amount', type: 'number', optional: false },
          { name: 'memo', optional: true, hint: 'Stored on both rows once the backend accepts memos (P2)' }
        ]
      end,

      execute: lambda do |_connection, input|
        post('/transfers').payload(input.slice('from', 'to', 'amount', 'memo'))
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'message' }, { name: 'from' }, { name: 'to' },
          { name: 'amount', type: 'number' }
        ]
      end
    },

    create_payment: {
      title: 'Pay another customer',
      description: "POST /payments: from one of the signed-in customer's accounts to another customer's checking, by email",

      input_fields: lambda do |_object_definitions|
        [
          { name: 'from', label: 'From account ID', optional: false },
          { name: 'to_email', label: "Recipient's email", optional: false },
          { name: 'amount', type: 'number', optional: false },
          { name: 'memo', optional: true, hint: 'Stored as sent on both rows' }
        ]
      end,

      execute: lambda do |_connection, input|
        post('/payments').payload(input.slice('from', 'to_email', 'amount', 'memo'))
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'message' }, { name: 'from' }, { name: 'to_email' },
          { name: 'amount', type: 'number' }
        ]
      end
    }
  },

  object_definitions: {
    account: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: 'accountId' }, { name: 'customerId' }, { name: 'name' },
          { name: 'type' }, { name: 'currency' }, { name: 'balance', type: 'number' }
        ]
      end
    },

    transaction: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: 'txnId' }, { name: 'accountId' }, { name: 'type' },
          { name: 'amount', type: 'number' }, { name: 'counterparty' }, { name: 'memo' },
          { name: 'channel' }, { name: 'category' }, { name: 'createdAt' }
        ]
      end
    }
  }
}
