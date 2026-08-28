using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin.Registration
{
    /// <summary>
    /// Pure overlay of an in-flight rule/action change onto the committed rule/action set,
    /// so a pre-operation registration reconcile plans against the effective post-commit
    /// state. Target attributes win. No I/O: a publish that adds a rule missing from the
    /// committed set receives that rule (loaded by the caller) as <c>extraRule</c>.
    /// </summary>
    public static class EffectiveState
    {
        private static readonly string ActionTypeField = SchemaNames.Qualify(SchemaNames.RuleAction.ActionType);
        private static readonly string ActionIsActiveField = SchemaNames.Qualify(SchemaNames.RuleAction.IsActive);

        public static List<Entity> ApplyRuleDelta(
            List<Entity> committed, InFlightChange change, Entity extraRule, string table)
        {
            var result = new List<Entity>(committed ?? Enumerable.Empty<Entity>());
            if (change == null || change.Entity != ChangeEntity.Rule) return result;

            if (change.IsRuleDelete || change.IsRuleUnpublish)
            {
                result.RemoveAll(r => r.Id == change.RecordId);
                return result;
            }

            if (change.IsRulePublish
                && string.Equals(change.EffectiveTable, table, StringComparison.OrdinalIgnoreCase))
            {
                var index = result.FindIndex(r => r.Id == change.RecordId);
                if (index < 0 && extraRule != null)
                {
                    var addedClone = CloneForOverlay(extraRule);
                    OverlayAttributes(addedClone, change.Target);
                    result.Add(addedClone);
                    return result;
                }
                if (index >= 0)
                {
                    var clone = CloneForOverlay(result[index]);
                    OverlayAttributes(clone, change.Target);
                    result[index] = clone;
                }
                return result;
            }

            if (change.Message == ChangeMessage.Update)
            {
                var index = result.FindIndex(r => r.Id == change.RecordId);
                if (index >= 0)
                {
                    var clone = CloneForOverlay(result[index]);
                    OverlayAttributes(clone, change.Target);
                    result[index] = clone;
                }
            }
            return result;
        }

        // Target attributes win. Only the Attributes bag is copied, so the entity's wired
        // RelatedEntities (condition groups) are preserved.
        private static void OverlayAttributes(Entity destination, Entity source)
        {
            if (source == null) return;
            foreach (var attr in source.Attributes)
                destination[attr.Key] = attr.Value;
        }

        // Never overlay onto a shared reference from the caller's committed list (or the
        // caller-supplied extraRule): clone first so ApplyRuleDelta never mutates its inputs.
        // The Attributes bag must be private per-clone; RelatedEntities entries are copied by
        // reference since the related graph itself is never mutated by an overlay.
        private static Entity CloneForOverlay(Entity e)
        {
            var clone = new Entity(e.LogicalName, e.Id);
            foreach (var a in e.Attributes) clone[a.Key] = a.Value;
            foreach (var r in e.RelatedEntities) clone.RelatedEntities[r.Key] = r.Value;
            return clone;
        }

        public static Dictionary<Guid, List<RuleAction>> ApplyActionDelta(
            Dictionary<Guid, List<RuleAction>> committed, InFlightChange change)
        {
            var result = Clone(committed);
            if (change == null || change.Entity != ChangeEntity.Action || !change.ParentRuleId.HasValue)
                return result;

            var ruleId = change.ParentRuleId.Value;
            if (!result.TryGetValue(ruleId, out var list))
            {
                list = new List<RuleAction>();
                result[ruleId] = list;
            }

            if (change.Message == ChangeMessage.Delete)
            {
                list.RemoveAll(a => a.Id == change.RecordId);
                return result;
            }

            // Create or Update: the step decision reads only ActionType + IsActive.
            var action = list.FirstOrDefault(a => a.Id == change.RecordId);
            if (action == null)
            {
                action = new RuleAction { Id = change.RecordId, RuleId = ruleId, IsActive = true };
                list.Add(action);
            }
            ApplyActionAttributes(action, change.Target);
            return result;
        }

        private static void ApplyActionAttributes(RuleAction action, Entity target)
        {
            if (target == null) return;
            if (target.Contains(ActionTypeField))
                action.ActionType = (ActionType)(target.GetAttributeValue<OptionSetValue>(ActionTypeField)?.Value ?? (int)action.ActionType);
            if (target.Contains(ActionIsActiveField))
                action.IsActive = target.GetAttributeValue<bool>(ActionIsActiveField);
        }

        // Deep-enough copy: new dictionary + new lists + copied RuleAction entries, so callers
        // never mutate the committed input.
        private static Dictionary<Guid, List<RuleAction>> Clone(Dictionary<Guid, List<RuleAction>> source)
        {
            var copy = new Dictionary<Guid, List<RuleAction>>();
            if (source == null) return copy;
            foreach (var pair in source)
                copy[pair.Key] = pair.Value.Select(Copy).ToList();
            return copy;
        }

        private static RuleAction Copy(RuleAction a) => new RuleAction
        {
            Id = a.Id,
            RuleId = a.RuleId,
            ActionType = a.ActionType,
            FireOn = a.FireOn,
            TargetColumn = a.TargetColumn,
            ValueBool = a.ValueBool,
            ApplyInverseWhenNotFired = a.ApplyInverseWhenNotFired,
            Message = a.Message,
            Severity = a.Severity,
            TargetTable = a.TargetTable,
            TargetNodeId = a.TargetNodeId,
            FieldMapping = a.FieldMapping,
            Order = a.Order,
            IsActive = a.IsActive,
            LocalizedMessages = new Dictionary<int, string>(a.LocalizedMessages)
        };
    }
}
