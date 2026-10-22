{
  title: 'Dewy Bank Support API',

  # The support agent's credential (Station C). Both support_api_url and
  # support_api_key are stamped connection fields; participants do not need to
  # enter anything for this connector. The API limits this key to the support
  # routes and to the fictional customers, so it can't reach a real
  # participant's accounts.
  connection: {
    fields: [
      { name: 'support_api_url', label: 'Support API URL',
        hint: 'API Gateway URL — set by stamping, do not edit',
        default: 'NOT_STAMPED' }, # support_api_url stamped before the workshop by scripts/stamp_bank_app_url.py
      { name: 'support_api_key', label: 'Support API key', control_type: 'password', optional: false,
        default: 'NOT_STAMPED' }, # stamped before the workshop by scripts/stamp_bank_app_url.py
    ],

    authorization: {
      type: 'custom_auth',

      acquire: lambda do |_connection|
        bank_app_url = 'NOT_STAMPED' # stamped before the workshop by scripts/stamp_bank_app_url.py
        if bank_app_url.include?('NOT_STAMPED')
          error('This connector has not been set up for a workshop yet: ask your facilitator.')
        end
        {}
      end,

      refresh_on: [401],

      apply: lambda do |connection|
        key = connection['support_api_key']
        if key.nil? || key.include?('NOT_STAMPED')
          error('The Support API connector has not been stamped for this workshop yet. Ask your facilitator.')
        end
        headers('x-api-key' => key)
      end
    },

    base_uri: lambda do |connection|
      connection['support_api_url']
    end
  },

  test: lambda do |_connection|
    get('/support/whoami')
  end,

  # Each action is a plain call to one Support API route: no checks, no
  # reshaping. Decisions belong to the recipes that call these actions.
  actions: {
    look_up_customer_accounts: {
      title: "Look up a customer's accounts",
      description: 'GET /support/customers/accounts: one fictional customer, by email',

      input_fields: lambda do |_object_definitions|
        [{ name: 'email', label: 'Customer email', optional: false }]
      end,

      execute: lambda do |_connection, input|
        get('/support/customers/accounts').params(email: input['email'])
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'customer', type: 'object', properties: [{ name: 'email' }] },
          { name: 'accounts', type: 'array', of: 'object', properties: object_definitions['account'] }
        ]
      end
    },

    adjust_balance: {
      title: "Adjust a customer's balance",
      description: 'POST /support/adjustments: one account of a fictional customer',

      input_fields: lambda do |_object_definitions|
        [
          { name: 'email', label: 'Customer email', optional: false },
          { name: 'account_id', label: 'Account ID', optional: false },
          { name: 'amount', type: 'number', optional: false },
          { name: 'reason', optional: true }
        ]
      end,

      execute: lambda do |_connection, input|
        post('/support/adjustments').payload(input.slice('email', 'account_id', 'amount', 'reason'))
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'message' }, { name: 'account_id' },
          { name: 'amount', type: 'number' }, { name: 'balance', type: 'number' }
        ]
      end
    }
  },

  object_definitions: {
    account: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: 'accountId' }, { name: 'name' }, { name: 'type' },
          { name: 'currency' }, { name: 'balance', type: 'number' }
        ]
      end
    }
  }
}
