import { Agent } from "agents";

import { getFixture, isFixtureId, type FixtureId } from "./fixture-data";
import type { Diagnosis } from "./diagnosis";
import type { Env } from "./env";
import {
  canReserveFollowUp,
  type FollowUpAnswer,
  type FollowUpExchange,
} from "./follow-up";
import { canReserveModelCall } from "./model-call-budget";
import type { ModelUsage } from "./workers-ai-response";
import type { ReviewedMemoryMatch } from "./review";
import { isDemoScopeId } from "./demo-session";

export type InvestigationStatus =
  | "idle"
  | "queued"
  | "collecting"
  | "diagnosing"
  | "complete"
  | "failed";

export type InvestigationState = {
  status: InvestigationStatus;
  fixtureId: FixtureId | null;
  workflowInstanceId: string | null;
  evidenceIds: string[];
  milestones: Array<{ stage: string; status: "pending" | "complete" }>;
  diagnosis: Diagnosis | null;
  memoryMatch: ReviewedMemoryMatch | null;
  modelCalls: number;
  modelUsage: ModelUsage | null;
  followUpCalls: number;
  followUps: FollowUpExchange[];
  error: string | null;
};

type InvestigationAgentState = InvestigationState & {
  ownerScopeId: string | null;
};

export type FollowUpReservation =
  | { status: "reserved"; exchange: FollowUpExchange }
  | { status: "existing"; exchange: FollowUpExchange }
  | { status: "not_ready" | "limit_reached" };

export class InvestigationAgent extends Agent<Env, InvestigationAgentState> {
  initialState: InvestigationAgentState = {
    status: "idle",
    fixtureId: null,
    workflowInstanceId: null,
    evidenceIds: [],
    milestones: [],
    diagnosis: null,
    memoryMatch: null,
    modelCalls: 0,
    modelUsage: null,
    followUpCalls: 0,
    followUps: [],
    error: null,
    ownerScopeId: null,
  };

  private currentState(): InvestigationAgentState {
    return {
      ...this.initialState,
      ...this.state,
      followUpCalls: Number.isInteger(this.state.followUpCalls)
        ? this.state.followUpCalls
        : 0,
      followUps: Array.isArray(this.state.followUps) ? this.state.followUps : [],
    };
  }

  async startInvestigation(
    fixtureIdValue: string,
    ownerScopeId: string,
  ): Promise<InvestigationState> {
    if (!isFixtureId(fixtureIdValue)) {
      throw new Error("fixture_not_allowed");
    }
    if (!isDemoScopeId(ownerScopeId)) {
      throw new Error("invalid_demo_memory_scope");
    }
    if (
      this.currentState().fixtureId === fixtureIdValue &&
      this.currentState().status !== "idle"
    ) {
      return this.currentState();
    }
    if (
      this.currentState().status !== "idle" &&
      this.currentState().fixtureId !== fixtureIdValue
    ) {
      throw new Error("session_fixture_conflict");
    }
    const fixture = getFixture(fixtureIdValue);
    this.setState({
      ...this.initialState,
      status: "queued",
      fixtureId: fixtureIdValue,
      ownerScopeId,
      evidenceIds: fixture.fixture.evidence_ids,
      milestones: [
        { stage: "load_evidence", status: "pending" },
        { stage: "recall_memory", status: "pending" },
        { stage: "diagnose", status: "pending" },
      ],
    });
    const workflowInstanceId = await this.runWorkflow(
      "INVESTIGATION_WORKFLOW",
      { fixtureId: fixtureIdValue, memoryScopeId: ownerScopeId },
      { agentBinding: "InvestigationAgent" },
    );
    this.setState({ ...this.currentState(), workflowInstanceId });
    return this.currentState();
  }

  async claimModelCall(): Promise<boolean> {
    if (
      this.currentState().status !== "diagnosing" ||
      !canReserveModelCall(this.currentState().modelCalls)
    ) {
      return false;
    }
    const state = this.currentState();
    this.setState({ ...state, modelCalls: state.modelCalls + 1 });
    return true;
  }

  async reserveFollowUp(
    messageId: string,
    question: string,
  ): Promise<FollowUpReservation> {
    if (!/^[a-f0-9]{64}$/.test(messageId)) throw new Error("invalid_message_id");
    if (question.length < 1 || question.length > 600) throw new Error("invalid_question");

    const state = this.currentState();
    const existing = state.followUps.find((item) => item.id === messageId);
    if (existing) return { status: "existing", exchange: existing };
    if (state.status !== "complete" || state.diagnosis === null) {
      return { status: "not_ready" };
    }
    if (!canReserveFollowUp(state.followUpCalls)) {
      return { status: "limit_reached" };
    }

    const exchange: FollowUpExchange = {
      id: messageId,
      question,
      status: "pending",
      answer: null,
      evidenceIds: [],
      usage: null,
      error: null,
    };
    this.setState({
      ...state,
      followUpCalls: state.followUpCalls + 1,
      followUps: [...state.followUps, exchange],
    });
    return { status: "reserved", exchange };
  }

  async completeFollowUp(
    messageId: string,
    answer: FollowUpAnswer,
    usage: ModelUsage,
  ): Promise<FollowUpExchange> {
    return this.updateFollowUp(messageId, (exchange) => ({
      ...exchange,
      status: "complete",
      answer: answer.answer,
      evidenceIds: answer.evidenceIds,
      usage,
      error: null,
    }));
  }

  async failFollowUp(messageId: string): Promise<FollowUpExchange> {
    return this.updateFollowUp(messageId, (exchange) => ({
      ...exchange,
      status: "failed",
      answer: null,
      evidenceIds: [],
      error: "follow_up_failed",
    }));
  }

  private updateFollowUp(
    messageId: string,
    update: (exchange: FollowUpExchange) => FollowUpExchange,
  ): FollowUpExchange {
    const state = this.currentState();
    const index = state.followUps.findIndex((item) => item.id === messageId);
    if (index < 0 || state.followUps[index].status !== "pending") {
      throw new Error("follow_up_not_pending");
    }
    const updated = update(state.followUps[index]);
    const followUps = [...state.followUps];
    followUps[index] = updated;
    this.setState({ ...state, followUps });
    return updated;
  }

  async onWorkflowError(
    _workflowName: string,
    workflowInstanceId: string,
    error: string,
  ): Promise<void> {
    if (
      this.currentState().workflowInstanceId !== null &&
      this.currentState().workflowInstanceId !== workflowInstanceId
    ) {
      return;
    }
    this.setState({
      ...this.currentState(),
      status: "failed",
      workflowInstanceId,
      error,
    });
  }

  getPublicState(): InvestigationState {
    const { ownerScopeId: _ownerScopeId, ...publicState } = this.currentState();
    return publicState;
  }

  getOwnerScopeId(): string | null {
    return this.currentState().ownerScopeId;
  }
}
