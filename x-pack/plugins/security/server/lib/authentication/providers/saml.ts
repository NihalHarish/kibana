/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import Boom from 'boom';
import { Request } from 'hapi';
import { Cluster } from 'src/legacy/core_plugins/elasticsearch';
import { canRedirectRequest } from '../../can_redirect_request';
import { getErrorStatusCode } from '../../errors';
import { AuthenticationResult } from '../authentication_result';
import { DeauthenticationResult } from '../deauthentication_result';

/**
 * Represents available provider options.
 */
interface ProviderOptions {
  protocol: string;
  hostname: string;
  port: number;
  basePath: string;
  client: Cluster;
  log: (tags: string[], message: string) => void;
}

/**
 * The state supported by the provider (for the SAML handshake or established session).
 */
interface ProviderState {
  /**
   * Unique identifier of the SAML request initiated the handshake.
   */
  requestId?: string;

  /**
   * URL to redirect user to after successful SAML handshake.
   */
  nextURL?: string;

  /**
   * Access token issued as the result of successful SAML handshake and that should be provided with
   * every request to Elasticsearch on behalf of the authenticated user. This token will eventually expire.
   */
  accessToken?: string;

  /**
   * Once access token expires the refresh token is used to get a new pair of access/refresh tokens
   * without any user involvement. If not used this token will eventually expire as well.
   */
  refreshToken?: string;
}

/**
 * Defines the shape of the request body containing SAML response.
 */
interface SAMLResponsePayload {
  SAMLResponse: string;
  RelayState?: string;
}

/**
 * Defines the shape of the request query containing SAML request.
 */
interface SAMLRequestQuery {
  SAMLRequest: string;
}

/**
 * If request with access token fails with `401 Unauthorized` then this token is no
 * longer valid and we should try to refresh it. Another use case that we should
 * temporarily support (until elastic/elasticsearch#38866 is fixed) is when token
 * document has been removed and ES responds with `500 Internal Server Error`.
 * @param err Error returned from Elasticsearch.
 */
function isAccessTokenExpiredError(err?: any) {
  const errorStatusCode = getErrorStatusCode(err);
  return (
    errorStatusCode === 401 ||
    (errorStatusCode === 500 &&
      err &&
      err.body &&
      err.body.error &&
      err.body.error.reason === 'token document is missing and must be present')
  );
}

/**
 * Checks whether request payload contains SAML response from IdP.
 * @param payload HTTP request body payload.
 */
function isSAMLResponsePayload(payload: any): payload is SAMLResponsePayload {
  return payload && payload.SAMLResponse;
}

/**
 * Checks whether request query includes SAML request from IdP.
 * @param query Parsed HTTP request query.
 */
function isSAMLRequestQuery(query: any): query is SAMLRequestQuery {
  return query && query.SAMLRequest;
}

/**
 * Provider that supports SAML request authentication.
 */
export class SAMLAuthenticationProvider {
  /**
   * Instantiates SAMLAuthenticationProvider.
   * @param options Options that may be needed by authentication provider.
   */
  constructor(private readonly options: ProviderOptions) {}

  /**
   * Performs SAML request authentication.
   * @param request HapiJS request instance.
   * @param [state] Optional state object associated with the provider.
   */
  public async authenticate(request: Request, state?: ProviderState | null) {
    this.options.log(
      ['debug', 'security', 'saml'],
      `Trying to authenticate user request to ${request.url.path}.`
    );

    let {
      authenticationResult,
      // tslint:disable-next-line prefer-const
      headerNotRecognized,
    } = await this.authenticateViaHeader(request);
    if (headerNotRecognized) {
      return authenticationResult;
    }

    if (state && authenticationResult.notHandled()) {
      authenticationResult = await this.authenticateViaState(request, state);
      if (authenticationResult.failed() && isAccessTokenExpiredError(authenticationResult.error)) {
        authenticationResult = await this.authenticateViaRefreshToken(request, state);
      }
    }

    if (authenticationResult.notHandled()) {
      // Let's check if user is redirected to Kibana from IdP with valid SAMLResponse.
      authenticationResult = await this.authenticateViaPayload(request, state);
    }

    // If we couldn't authenticate by means of all methods above, let's try to
    // initiate SAML handshake, otherwise just return authentication result we have.
    return authenticationResult.notHandled()
      ? await this.authenticateViaHandshake(request)
      : authenticationResult;
  }

  /**
   * Invalidates SAML access token if it exists.
   * @param request HapiJS request instance.
   * @param state State value previously stored by the provider.
   */
  public async deauthenticate(request: Request, state?: ProviderState) {
    this.options.log(
      ['debug', 'security', 'saml'],
      `Trying to deauthenticate user via ${request.url.path}.`
    );

    if ((!state || !state.accessToken) && !isSAMLRequestQuery(request.query)) {
      this.options.log(
        ['debug', 'security', 'saml'],
        'There is neither access token nor SAML session to invalidate.'
      );
      return DeauthenticationResult.notHandled();
    }

    let logoutArgs: [
      'shield.samlInvalidate' | 'shield.samlLogout',
      { body: Record<string, unknown> }
    ];
    if (isSAMLRequestQuery(request.query)) {
      this.options.log(
        ['debug', 'security', 'saml'],
        'Logout has been initiated by the Identity Provider.'
      );
      logoutArgs = [
        'shield.samlInvalidate',
        // Elasticsearch expects `queryString` without leading `?`, so we should strip it with `slice`.
        {
          body: {
            queryString: request.url.search ? request.url.search.slice(1) : '',
            acs: this.getACS(),
          },
        },
      ];
    } else {
      this.options.log(['debug', 'security', 'saml'], 'Logout has been initiated by the user.');
      logoutArgs = [
        'shield.samlLogout',
        { body: { token: state!.accessToken, refresh_token: state!.refreshToken } },
      ];
    }

    try {
      // This operation should be performed on behalf of the user with a privilege that normal
      // user usually doesn't have `cluster:admin/xpack/security/saml/logout (invalidate)`.
      const { redirect } = await this.options.client.callWithInternalUser(...logoutArgs);

      this.options.log(
        ['debug', 'security', 'saml'],
        'User session has been successfully invalidated.'
      );

      // Having non-null `redirect` field within logout response means that IdP
      // supports SAML Single Logout and we should redirect user to the specified
      // location to properly complete logout.
      if (redirect != null) {
        this.options.log(
          ['debug', 'security', 'saml'],
          'Redirecting user to Identity Provider to complete logout.'
        );
        return DeauthenticationResult.redirectTo(redirect);
      }

      return DeauthenticationResult.redirectTo('/logged_out');
    } catch (err) {
      this.options.log(
        ['debug', 'security', 'saml'],
        `Failed to deauthenticate user: ${err.message}`
      );
      return DeauthenticationResult.failed(err);
    }
  }

  /**
   * Validates whether request contains `Bearer ***` Authorization header and just passes it
   * forward to Elasticsearch backend.
   * @param request HapiJS request instance.
   */
  private async authenticateViaHeader(request: Request) {
    this.options.log(['debug', 'security', 'saml'], 'Trying to authenticate via header.');

    const authorization = request.headers.authorization;
    if (!authorization) {
      this.options.log(['debug', 'security', 'saml'], 'Authorization header is not presented.');
      return { authenticationResult: AuthenticationResult.notHandled() };
    }

    const authenticationSchema = authorization.split(/\s+/)[0];
    if (authenticationSchema.toLowerCase() !== 'bearer') {
      this.options.log(
        ['debug', 'security', 'saml'],
        `Unsupported authentication schema: ${authenticationSchema}`
      );
      return {
        authenticationResult: AuthenticationResult.notHandled(),
        headerNotRecognized: true,
      };
    }

    try {
      const user = await this.options.client.callWithRequest(request, 'shield.authenticate');

      this.options.log(['debug', 'security', 'saml'], 'Request has been authenticated via header.');

      return { authenticationResult: AuthenticationResult.succeeded(user) };
    } catch (err) {
      this.options.log(
        ['debug', 'security', 'saml'],
        `Failed to authenticate request via header: ${err.message}`
      );
      return { authenticationResult: AuthenticationResult.failed(err) };
    }
  }

  /**
   * Validates whether request payload contains `SAMLResponse` parameter that can be exchanged
   * to a proper access token. If state is presented and includes request id then it means
   * that login attempt has been initiated by Kibana itself and request id must be sent to
   * Elasticsearch together with corresponding `SAMLResponse`. Not having state at this stage is
   * indication of potential IdP initiated login, so we should send only `SAMLResponse` that
   * Elasticsearch will decrypt and figure out on its own if it's a legit response from IdP
   * initiated login.
   *
   * When login succeeds access token is stored in the state and user is redirected to the URL
   * that was requested before SAML handshake or to default Kibana location in case of IdP
   * initiated login.
   * @param request HapiJS request instance.
   * @param [state] Optional state object associated with the provider.
   */
  private async authenticateViaPayload(request: Request, state?: ProviderState | null) {
    this.options.log(
      ['debug', 'security', 'saml'],
      'Trying to authenticate via SAML response payload.'
    );

    if (!isSAMLResponsePayload(request.payload)) {
      this.options.log(['debug', 'security', 'saml'], 'SAML response payload is not found.');
      return AuthenticationResult.notHandled();
    }

    // If we have a `SAMLResponse` and state, but state doesn't contain all the necessary information,
    // then something unexpected happened and we should fail.
    const { requestId: stateRequestId, nextURL: stateRedirectURL } = state || {
      requestId: '',
      nextURL: '',
    };
    if (state && (!stateRequestId || !stateRedirectURL)) {
      const message = 'SAML response state does not have corresponding request id or redirect URL.';
      this.options.log(['debug', 'security', 'saml'], message);

      return AuthenticationResult.failed(Boom.badRequest(message));
    }

    // When we don't have state and hence request id we assume that SAMLResponse came from the IdP initiated login.
    if (stateRequestId) {
      this.options.log(
        ['debug', 'security', 'saml'],
        'Authentication has been previously initiated by Kibana.'
      );
    } else {
      this.options.log(
        ['debug', 'security', 'saml'],
        'Authentication has been initiated by Identity Provider.'
      );
    }

    try {
      // This operation should be performed on behalf of the user with a privilege that normal
      // user usually doesn't have `cluster:admin/xpack/security/saml/authenticate`.
      const {
        access_token: accessToken,
        refresh_token: refreshToken,
      } = await this.options.client.callWithInternalUser('shield.samlAuthenticate', {
        body: {
          ids: stateRequestId ? [stateRequestId] : [],
          content: request.payload.SAMLResponse,
        },
      });

      this.options.log(
        ['debug', 'security', 'saml'],
        'Request has been authenticated via SAML response.'
      );

      return AuthenticationResult.redirectTo(stateRedirectURL || `${this.options.basePath}/`, {
        accessToken,
        refreshToken,
      });
    } catch (err) {
      this.options.log(
        ['debug', 'security', 'saml'],
        `Failed to authenticate request via SAML response: ${err.message}`
      );
      return AuthenticationResult.failed(err);
    }
  }

  /**
   * Tries to extract access token from state and adds it to the request before it's
   * forwarded to Elasticsearch backend.
   * @param request HapiJS request instance.
   * @param state State value previously stored by the provider.
   */
  private async authenticateViaState(request: Request, { accessToken }: ProviderState) {
    this.options.log(['debug', 'security', 'saml'], 'Trying to authenticate via state.');

    if (!accessToken) {
      this.options.log(['debug', 'security', 'saml'], 'Access token is not found in state.');
      return AuthenticationResult.notHandled();
    }

    request.headers.authorization = `Bearer ${accessToken}`;

    try {
      const user = await this.options.client.callWithRequest(request, 'shield.authenticate');

      this.options.log(['debug', 'security', 'saml'], 'Request has been authenticated via state.');

      return AuthenticationResult.succeeded(user);
    } catch (err) {
      this.options.log(
        ['debug', 'security', 'saml'],
        `Failed to authenticate request via state: ${err.message}`
      );

      // Reset `Authorization` header we've just set. We know for sure that it hasn't been defined before,
      // otherwise it would have been used or completely rejected by the `authenticateViaHeader`.
      // We can't just set `authorization` to `undefined` or `null`, we should remove this property
      // entirely, otherwise `authorization` header without value will cause `callWithRequest` to fail if
      // it's called with this request once again down the line (e.g. in the next authentication provider).
      delete request.headers.authorization;

      return AuthenticationResult.failed(err);
    }
  }

  /**
   * This method is only called when authentication via access token stored in the state failed because of expired
   * token. So we should use refresh token, that is also stored in the state, to extend expired access token and
   * authenticate user with it.
   * @param request HapiJS request instance.
   * @param state State value previously stored by the provider.
   */
  private async authenticateViaRefreshToken(request: Request, { refreshToken }: ProviderState) {
    this.options.log(['debug', 'security', 'saml'], 'Trying to refresh access token.');

    if (!refreshToken) {
      this.options.log(['debug', 'security', 'saml'], 'Refresh token is not found in state.');
      return AuthenticationResult.notHandled();
    }

    try {
      // Token should be refreshed by the same user that obtained that token.
      const {
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
      } = await this.options.client.callWithInternalUser('shield.getAccessToken', {
        body: { grant_type: 'refresh_token', refresh_token: refreshToken },
      });

      this.options.log(
        ['debug', 'security', 'saml'],
        'Access token has been successfully refreshed.'
      );

      request.headers.authorization = `Bearer ${newAccessToken}`;

      const user = await this.options.client.callWithRequest(request, 'shield.authenticate');

      this.options.log(
        ['debug', 'security', 'saml'],
        'Request has been authenticated via refreshed token.'
      );

      return AuthenticationResult.succeeded(user, {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      });
    } catch (err) {
      this.options.log(
        ['debug', 'security', 'saml'],
        `Failed to refresh access token: ${err.message}`
      );

      // Reset `Authorization` header we've just set. We know for sure that it hasn't been defined before,
      // otherwise it would have been used or completely rejected by the `authenticateViaHeader`.
      // We can't just set `authorization` to `undefined` or `null`, we should remove this property
      // entirely, otherwise `authorization` header without value will cause `callWithRequest` to fail if
      // it's called with this request once again down the line (e.g. in the next authentication provider).
      delete request.headers.authorization;

      // There are at least two common cases when refresh token request can fail:
      // 1. Refresh token is valid only for 24 hours and if it hasn't been used it expires.
      //
      // 2. Refresh token is one-time use token and if it has been used already, it is treated in the same way as
      // expired token. Even though it's an edge case, there are several perfectly valid scenarios when it can
      // happen. E.g. when several simultaneous AJAX request has been sent to Kibana, but access token has expired
      // already, so the first request that reaches Kibana uses refresh token to get a new access token, but the
      // second concurrent request has no idea about that and tries to refresh access token as well. All ends well
      // when first request refreshes access token and updates session cookie with fresh access/refresh token pair.
      // But if user navigates to another page _before_ AJAX request (the one that triggered token refresh) responds
      // with updated cookie, then user will have only that old cookie with expired access token and refresh token
      // that has been used already.
      //
      // When user has neither valid access nor refresh token, the only way to resolve this issue is to get new
      // SAML LoginResponse and exchange it for a new access/refresh token pair. To do that we initiate a new SAML
      // handshake. Obviously we can't do that for AJAX requests, so we just reply with `400` and clear error message.
      // There are two reasons for `400` and not `401`: Elasticsearch search responds with `400` so it seems logical
      // to do the same on Kibana side and `401` would force user to logout and do full SLO if it's supported.
      if (getErrorStatusCode(err) === 400) {
        if (canRedirectRequest(request)) {
          this.options.log(
            ['debug', 'security', 'saml'],
            'Both access and refresh tokens are expired. Re-initiating SAML handshake.'
          );
          return this.authenticateViaHandshake(request);
        }

        return AuthenticationResult.failed(
          Boom.badRequest('Both access and refresh tokens are expired.')
        );
      }

      return AuthenticationResult.failed(err);
    }
  }

  /**
   * Tries to start SAML handshake and eventually receive a token.
   * @param request HapiJS request instance.
   */
  private async authenticateViaHandshake(request: Request) {
    this.options.log(['debug', 'security', 'saml'], 'Trying to initiate SAML handshake.');

    // If client can't handle redirect response, we shouldn't initiate SAML handshake.
    if (!canRedirectRequest(request)) {
      this.options.log(
        ['debug', 'security', 'saml'],
        'SAML handshake can not be initiated by AJAX requests.'
      );
      return AuthenticationResult.notHandled();
    }

    try {
      // This operation should be performed on behalf of the user with a privilege that normal
      // user usually doesn't have `cluster:admin/xpack/security/saml/prepare`.
      const { id: requestId, redirect } = await this.options.client.callWithInternalUser(
        'shield.samlPrepare',
        { body: { acs: this.getACS() } }
      );

      this.options.log(
        ['debug', 'security', 'saml'],
        'Redirecting to Identity Provider with SAML request.'
      );

      return AuthenticationResult.redirectTo(
        redirect,
        // Store request id in the state so that we can reuse it once we receive `SAMLResponse`.
        { requestId, nextURL: `${request.getBasePath()}${request.url.path}` }
      );
    } catch (err) {
      this.options.log(
        ['debug', 'security', 'saml'],
        `Failed to initiate SAML handshake: ${err.message}`
      );
      return AuthenticationResult.failed(err);
    }
  }

  /**
   * Constructs and returns Kibana's Assertion consumer service URL.
   */
  private getACS() {
    return (
      `${this.options.protocol}://${this.options.hostname}:${this.options.port}` +
      `${this.options.basePath}/api/security/v1/saml`
    );
  }
}
