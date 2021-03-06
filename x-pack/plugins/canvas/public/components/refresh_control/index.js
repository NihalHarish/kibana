/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { connect } from 'react-redux';
import { fetchAllRenderables } from '../../state/actions/elements';
import { setRefreshInterval } from '../../state/actions/workpad';
import { getInFlight } from '../../state/selectors/resolved_args';
import { getRefreshInterval, getElementStats } from '../../state/selectors/workpad';
import { RefreshControl as Component } from './refresh_control';

const mapStateToProps = state => ({
  inFlight: getInFlight(state),
  refreshInterval: getRefreshInterval(state),
  elementStats: getElementStats(state),
});

const mapDispatchToProps = {
  doRefresh: fetchAllRenderables,
  setRefreshInterval,
};

export const RefreshControl = connect(
  mapStateToProps,
  mapDispatchToProps
)(Component);
